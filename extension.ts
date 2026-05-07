import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PACKAGE_NAME = "pi-nvim-bridge";
const VERSION = "0.1.0";
const SOCKETS_DIR = path.join(os.tmpdir(), "pi-nvim-bridge-sockets");
const LATEST_LINK = path.join(os.tmpdir(), "pi-nvim-bridge-latest.sock");
const MAX_STORED_TEXT_BYTES = 64 * 1024;
const DEFAULT_TOOL_MAX_BYTES = 24 * 1024;
const STATUS_ICON_CONNECTED = "";
const STATUS_ICON_WAITING = "○";

type DeliveryMode = "steer" | "followUp";

type CursorSnapshot = {
	line: number;
	column: number;
};

type RangeSnapshot = {
	startLine: number;
	endLine: number;
	text?: string;
	textTruncated?: boolean;
};

type BufferSnapshot = {
	path?: string;
	relativePath?: string;
	filetype?: string;
	dirty?: boolean;
	changedtick?: number;
	lineCount?: number;
};

type DiagnosticSnapshot = {
	line?: number;
	column?: number;
	severity?: string;
	message?: string;
	source?: string;
};

type CodeDiffLineRange = {
	startLine?: number;
	endLineExclusive?: number;
};

type CodeDiffHunk = {
	index?: number;
	original?: CodeDiffLineRange;
	modified?: CodeDiffLineRange;
	opposite?: CodeDiffLineRange;
};

type CodeDiffSnapshot = {
	active?: boolean;
	mode?: string;
	layout?: string;
	side?: string;
	gitRoot?: string;
	originalPath?: string;
	modifiedPath?: string;
	originalRevision?: string;
	modifiedRevision?: string;
	currentPath?: string;
	currentAbsolutePath?: string;
	currentRevision?: string;
	selectedLineRange?: { startLine?: number; endLine?: number };
	hunks?: CodeDiffHunk[];
};

type EditorSnapshot = {
	type?: string;
	clientId?: string;
	seq?: number;
	reason?: string;
	cwd?: string;
	workspaceRoot?: string;
	mode?: string;
	buffer?: BufferSnapshot;
	cursor?: CursorSnapshot;
	selection?: ({ active?: boolean } & Partial<RangeSnapshot>);
	visibleRange?: RangeSnapshot;
	diagnostics?: DiagnosticSnapshot[];
	diagnosticCounts?: Record<string, number>;
	codediff?: CodeDiffSnapshot;
	updatedAt?: string;
};

type Manifest = {
	name: string;
	version: string;
	pid: number;
	cwd: string;
	workspaceRoot: string;
	sessionId: string;
	sessionFile?: string;
	socket: string;
	startedAt: string;
	capabilities: string[];
};

function hashText(value: string): string {
	return crypto.createHash("sha1").update(value).digest("hex");
}

function socketPathFor(workspaceRoot: string): string {
	return path.join(SOCKETS_DIR, `${hashText(workspaceRoot).slice(0, 12)}-${process.pid}.sock`);
}

function findWorkspaceRoot(start: string): string {
	let current = path.resolve(start);
	let previous = "";
	while (current !== previous) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		previous = current;
		current = path.dirname(current);
	}
	return path.resolve(start);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string | undefined, maxBytes: number): { text: string | undefined; truncated: boolean } {
	if (typeof value !== "string") return { text: undefined, truncated: false };
	if (byteLength(value) <= maxBytes) return { text: value, truncated: false };
	let bytes = 0;
	let out = "";
	for (const char of value) {
		const next = Buffer.byteLength(char, "utf8");
		if (bytes + next > Math.max(0, maxBytes - 1)) break;
		bytes += next;
		out += char;
	}
	return { text: `${out}…`, truncated: true };
}

function sanitizeRange(range: EditorSnapshot["selection"] | EditorSnapshot["visibleRange"] | undefined): RangeSnapshot | undefined {
	if (!range || typeof range.startLine !== "number" || typeof range.endLine !== "number") return undefined;
	const truncated = truncateUtf8(typeof range.text === "string" ? range.text : undefined, MAX_STORED_TEXT_BYTES);
	return {
		startLine: range.startLine,
		endLine: range.endLine,
		...(truncated.text !== undefined ? { text: truncated.text } : {}),
		...(range.textTruncated || truncated.truncated ? { textTruncated: true } : {}),
	};
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
	return typeof source[key] === "string" ? source[key] : undefined;
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
	return typeof source[key] === "number" ? source[key] : undefined;
}

function positiveIntegerField(source: Record<string, unknown>, key: string): number | undefined {
	const value = numberField(source, key);
	return value !== undefined && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function sanitizeCodeDiffLineRange(value: unknown): CodeDiffLineRange | undefined {
	if (!isObject(value)) return undefined;
	const startLine = positiveIntegerField(value, "startLine");
	const endLineExclusive = positiveIntegerField(value, "endLineExclusive");
	if (startLine === undefined || endLineExclusive === undefined || endLineExclusive < startLine) return undefined;
	return { startLine, endLineExclusive };
}

function sanitizeCodeDiffSnapshot(value: unknown): CodeDiffSnapshot | undefined {
	if (!isObject(value) || value.active !== true) return undefined;
	const selectedLineRange = isObject(value.selectedLineRange)
		? {
				startLine: positiveIntegerField(value.selectedLineRange, "startLine"),
				endLine: positiveIntegerField(value.selectedLineRange, "endLine"),
			}
		: undefined;
	const hunks = Array.isArray(value.hunks)
		? value.hunks.slice(0, 50).filter(isObject).map((hunk) => ({
				index: numberField(hunk, "index"),
				original: sanitizeCodeDiffLineRange(hunk.original),
				modified: sanitizeCodeDiffLineRange(hunk.modified),
				opposite: sanitizeCodeDiffLineRange(hunk.opposite),
			}))
		: undefined;
	return {
		active: true,
		mode: stringField(value, "mode"),
		layout: stringField(value, "layout"),
		side: stringField(value, "side"),
		gitRoot: stringField(value, "gitRoot"),
		originalPath: stringField(value, "originalPath"),
		modifiedPath: stringField(value, "modifiedPath"),
		originalRevision: stringField(value, "originalRevision"),
		modifiedRevision: stringField(value, "modifiedRevision"),
		currentPath: stringField(value, "currentPath"),
		currentAbsolutePath: stringField(value, "currentAbsolutePath"),
		currentRevision: stringField(value, "currentRevision"),
		...(selectedLineRange?.startLine !== undefined && selectedLineRange.endLine !== undefined ? { selectedLineRange } : {}),
		...(hunks ? { hunks } : {}),
	};
}

function sanitizeSnapshot(raw: unknown, fallbackWorkspaceRoot: string): EditorSnapshot {
	if (!isObject(raw)) throw new Error("context_sync payload must be an object");
	const buffer = isObject(raw.buffer) ? (raw.buffer as BufferSnapshot) : undefined;
	const cursor = isObject(raw.cursor) ? (raw.cursor as CursorSnapshot) : undefined;
	const selectionRaw = isObject(raw.selection) ? (raw.selection as EditorSnapshot["selection"]) : undefined;
	const visibleRangeRaw = isObject(raw.visibleRange) ? (raw.visibleRange as EditorSnapshot["visibleRange"]) : undefined;
	const selectionRange = sanitizeRange(selectionRaw);
	const diagnostics = Array.isArray(raw.diagnostics)
		? raw.diagnostics.slice(0, 50).filter(isObject).map((diagnostic) => diagnostic as DiagnosticSnapshot)
		: undefined;

	return {
		clientId: typeof raw.clientId === "string" ? raw.clientId : undefined,
		seq: typeof raw.seq === "number" ? raw.seq : undefined,
		reason: typeof raw.reason === "string" ? raw.reason : undefined,
		cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
		workspaceRoot: typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : fallbackWorkspaceRoot,
		mode: typeof raw.mode === "string" ? raw.mode : undefined,
		buffer,
		cursor,
		selection: selectionRaw
			? {
					active: Boolean(selectionRaw.active),
					...selectionRange,
				}
			: undefined,
		visibleRange: sanitizeRange(visibleRangeRaw),
		diagnostics,
		diagnosticCounts: isObject(raw.diagnosticCounts) ? (raw.diagnosticCounts as Record<string, number>) : undefined,
		codediff: sanitizeCodeDiffSnapshot(raw.codediff),
		updatedAt: new Date().toISOString(),
	};
}

function relativeFile(snapshot: EditorSnapshot | undefined): string {
	return snapshot?.buffer?.relativePath || snapshot?.buffer?.path || "(no file)";
}

function statusFile(snapshot: EditorSnapshot | undefined): string {
	const file = relativeFile(snapshot);
	return file === "(no file)" ? file : path.basename(file);
}

function formatDiagnosticCounts(counts: Record<string, number> | undefined): string | undefined {
	if (!counts) return undefined;
	const parts = Object.entries(counts)
		.filter(([, count]) => typeof count === "number" && count > 0)
		.map(([severity, count]) => `${severity}:${count}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function revisionLabel(revision: string | undefined): string {
	return revision || "working tree";
}

function formatExclusiveRange(range: CodeDiffLineRange | undefined): string | undefined {
	if (!range || typeof range.startLine !== "number" || typeof range.endLineExclusive !== "number") return undefined;
	const displayEnd = Math.max(range.startLine, range.endLineExclusive - 1);
	return range.startLine === displayEnd ? `${range.startLine}` : `${range.startLine}-${displayEnd}`;
}

function buildCodeDiffSummary(snapshot: EditorSnapshot | undefined): string | undefined {
	const codediff = snapshot?.codediff;
	if (!codediff?.active) return undefined;
	const parts = [`${codediff.side ?? "unknown side"}`];
	if (codediff.layout) parts.push(`${codediff.layout} layout`);
	if (codediff.mode) parts.push(`${codediff.mode} mode`);
	if (codediff.currentPath) parts.push(`${revisionLabel(codediff.currentRevision)}:${codediff.currentPath}`);
	const hunkCount = codediff.hunks?.length ?? 0;
	if (hunkCount > 0) parts.push(`${hunkCount} overlapping hunk${hunkCount === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function buildCodeDiffContext(snapshot: EditorSnapshot | undefined): string[] {
	const codediff = snapshot?.codediff;
	if (!codediff?.active) return [];
	const lines = ["CodeDiff context:"];
	lines.push(`- side: ${codediff.side ?? "unknown"}${codediff.layout ? ` (${codediff.layout})` : ""}`);
	if (codediff.gitRoot) lines.push(`- git root: ${codediff.gitRoot}`);
	if (codediff.currentPath) lines.push(`- selected side: ${revisionLabel(codediff.currentRevision)} ${codediff.currentPath}`);
	if (codediff.selectedLineRange?.startLine !== undefined && codediff.selectedLineRange.endLine !== undefined) {
		const range =
			codediff.selectedLineRange.startLine === codediff.selectedLineRange.endLine
				? `${codediff.selectedLineRange.startLine}`
				: `${codediff.selectedLineRange.startLine}-${codediff.selectedLineRange.endLine}`;
		lines.push(`- selected range: ${range}`);
	}
	if (codediff.originalPath || codediff.modifiedPath) {
		lines.push(`- original: ${revisionLabel(codediff.originalRevision)} ${codediff.originalPath ?? "(unknown path)"}`);
		lines.push(`- modified: ${revisionLabel(codediff.modifiedRevision)} ${codediff.modifiedPath ?? "(unknown path)"}`);
	}
	const hunks = codediff.hunks ?? [];
	if (hunks.length > 0) {
		lines.push("- overlapping hunks:");
		for (const hunk of hunks.slice(0, 10)) {
			const original = formatExclusiveRange(hunk.original) ?? "?";
			const modified = formatExclusiveRange(hunk.modified) ?? "?";
			lines.push(`  - #${hunk.index ?? "?"}: original ${original} ↔ modified ${modified}`);
		}
	}
	return lines;
}

function buildSummary(snapshot: EditorSnapshot | undefined): string {
	if (!snapshot) return "No Neovim editor context has been synced yet.";
	const lines = ["Current Neovim context:"];
	lines.push(`- active file: ${relativeFile(snapshot)}`);
	if (snapshot.buffer?.filetype) lines.push(`- filetype: ${snapshot.buffer.filetype}`);
	if (snapshot.buffer?.dirty !== undefined) lines.push(`- buffer dirty: ${snapshot.buffer.dirty ? "yes" : "no"}`);
	if (snapshot.cursor) lines.push(`- cursor: line ${snapshot.cursor.line}, column ${snapshot.cursor.column}`);
	if (snapshot.selection?.active && snapshot.selection.startLine && snapshot.selection.endLine) {
		lines.push(`- visual selection: lines ${snapshot.selection.startLine}-${snapshot.selection.endLine}`);
	} else {
		lines.push("- visual selection: none");
	}
	if (snapshot.visibleRange) lines.push(`- visible range: lines ${snapshot.visibleRange.startLine}-${snapshot.visibleRange.endLine}`);
	const diagnosticCounts = formatDiagnosticCounts(snapshot.diagnosticCounts);
	if (diagnosticCounts) lines.push(`- diagnostics: ${diagnosticCounts}`);
	const codeDiffSummary = buildCodeDiffSummary(snapshot);
	if (codeDiffSummary) lines.push(`- codediff: ${codeDiffSummary}`);
	if (snapshot.updatedAt) lines.push(`- synced at: ${snapshot.updatedAt}`);
	return lines.join("\n");
}

function getActiveSelection(snapshot: EditorSnapshot | undefined): (RangeSnapshot & { active?: boolean }) | undefined {
	const selection = snapshot?.selection;
	if (!selection?.active) return undefined;
	if (typeof selection.startLine !== "number" || typeof selection.endLine !== "number") return undefined;
	if (typeof selection.text !== "string" || selection.text.length === 0) return undefined;
	return selection as RangeSnapshot & { active?: boolean };
}

function selectionDigest(snapshot: EditorSnapshot | undefined): string | undefined {
	const selection = getActiveSelection(snapshot);
	if (!selection) return undefined;
	return hashText(
		[
			snapshot?.buffer?.path ?? "",
			snapshot?.buffer?.changedtick ?? "",
			snapshot?.codediff?.side ?? "",
			snapshot?.codediff?.currentPath ?? "",
			snapshot?.codediff?.currentRevision ?? "",
			selection.startLine,
			selection.endLine,
			selection.text ?? "",
		].join("\0"),
	);
}

function buildSelectionContext(snapshot: EditorSnapshot | undefined): string | undefined {
	const selection = getActiveSelection(snapshot);
	if (!selection) return undefined;
	const file = relativeFile(snapshot);
	const filetype = snapshot?.buffer?.filetype ?? "text";
	const truncated = selection.textTruncated ? " (selection text was truncated by pi-nvim-bridge)" : "";
	return [
		`Neovim visual selection from ${file} lines ${selection.startLine}-${selection.endLine}${truncated}:`,
		...buildCodeDiffContext(snapshot),
		"",
		`\`\`\`${filetype}`,
		selection.text ?? "",
		"```",
	].join("\n");
}

function contextDigest(snapshot: EditorSnapshot | undefined): string | undefined {
	if (!snapshot) return undefined;
	return hashText(
		JSON.stringify({
			cwd: snapshot.cwd,
			workspaceRoot: snapshot.workspaceRoot,
			mode: snapshot.mode,
			buffer: snapshot.buffer,
			cursor: snapshot.cursor,
			selection: snapshot.selection,
			visibleRange: snapshot.visibleRange,
			diagnostics: snapshot.diagnostics,
			diagnosticCounts: snapshot.diagnosticCounts,
			codediff: snapshot.codediff,
		}),
	);
}

function buildContextChangedSignal(snapshot: EditorSnapshot): string {
	return [
		"The Neovim editor context has changed since the last update.",
		buildSummary(snapshot),
		"Detailed selection, visible range, diagnostics, and CodeDiff context are available through the editor_context tool.",
	].join("\n\n");
}

function clipSection(title: string, text: string | undefined, maxBytes: number): string {
	if (!text) return `${title}: (none)`;
	const clipped = truncateUtf8(text, maxBytes);
	return `${title}${clipped.truncated ? ` (truncated to ${maxBytes} bytes)` : ""}:\n${clipped.text ?? ""}`;
}

function formatToolContext(snapshot: EditorSnapshot | undefined, include: string, maxBytes: number): string {
	if (!snapshot) return "No Neovim editor context has been synced yet.";
	const parts: string[] = [];
	if (include === "summary" || include === "all") parts.push(buildSummary(snapshot));
	if (include === "selection" || include === "all") parts.push(clipSection("Selection", snapshot.selection?.active ? snapshot.selection.text : undefined, maxBytes));
	if (include === "visible_range" || include === "all") parts.push(clipSection("Visible range", snapshot.visibleRange?.text, maxBytes));
	if (include === "diagnostics" || include === "all") {
		const diagnostics = snapshot.diagnostics ?? [];
		parts.push(
			diagnostics.length === 0
				? "Diagnostics: none"
				: `Diagnostics:\n${diagnostics
						.slice(0, 25)
						.map((diagnostic) => {
							const location = diagnostic.line ? `${diagnostic.line}:${diagnostic.column ?? 1}` : "?";
							return `- ${location} ${diagnostic.severity ?? "diagnostic"}${diagnostic.source ? ` [${diagnostic.source}]` : ""}: ${diagnostic.message ?? ""}`;
						})
						.join("\n")}`,
		);
	}
	return parts.filter(Boolean).join("\n\n");
}

function normalizeDeliveryMode(value: unknown): DeliveryMode {
	return value === "followUp" ? "followUp" : "steer";
}

function respond(conn: net.Socket, payload: unknown): void {
	try {
		conn.write(`${JSON.stringify(payload)}\n`);
	} catch {
		// ignore broken clients
	}
}

function updateStatus(snapshot: EditorSnapshot | undefined, ctx: ExtensionContext | undefined, options?: { clear?: boolean }): void {
	if (!ctx?.hasUI) return;
	if (options?.clear) {
		ctx.ui.setStatus(PACKAGE_NAME, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	if (!snapshot) {
		ctx.ui.setStatus(PACKAGE_NAME, `${theme.fg("dim", STATUS_ICON_WAITING)} ${theme.fg("dim", "nvim")}`);
		return;
	}
	let location = snapshot.cursor ? `:${snapshot.cursor.line}` : "";
	if (snapshot.selection?.active && typeof snapshot.selection.startLine === "number" && typeof snapshot.selection.endLine === "number") {
		location = snapshot.selection.startLine === snapshot.selection.endLine ? `:${snapshot.selection.startLine}` : `:${snapshot.selection.startLine}-${snapshot.selection.endLine}`;
	}
	const file = statusFile(snapshot);
	ctx.ui.setStatus(PACKAGE_NAME, `${theme.fg("success", STATUS_ICON_CONNECTED)} ${theme.fg("dim", file)}${theme.fg("muted", location)}`);
}

export default function (pi: ExtensionAPI) {
	let server: net.Server | undefined;
	let socketPath: string | undefined;
	let manifestPath: string | undefined;
	let latestCtx: ExtensionContext | undefined;
	let latestSnapshot: EditorSnapshot | undefined;
	let latestContextDigest: string | undefined;
	let lastSignaledContextDigest: string | undefined;
	let lastInjectedSelectionDigest: string | undefined;
	let isIdle = true;

	function cleanup(): void {
		if (server) {
			try {
				server.close();
			} catch {}
			server = undefined;
		}
		for (const target of [socketPath, manifestPath]) {
			if (!target) continue;
			try {
				fs.unlinkSync(target);
			} catch {}
		}
		try {
			if (socketPath && fs.readlinkSync(LATEST_LINK) === socketPath) fs.unlinkSync(LATEST_LINK);
		} catch {}
	}

	function writeManifest(ctx: ExtensionContext, workspaceRoot: string): void {
		if (!socketPath) return;
		const manifest: Manifest = {
			name: PACKAGE_NAME,
			version: VERSION,
			pid: process.pid,
			cwd: ctx.cwd,
			workspaceRoot,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			socket: socketPath,
			startedAt: new Date().toISOString(),
			capabilities: ["context_sync", "prompt", "editor_context", "streamingBehavior", "disconnect"],
		};
		fs.writeFileSync(`${socketPath}.info`, JSON.stringify(manifest));
		manifestPath = `${socketPath}.info`;
	}

	function handlePrompt(msg: Record<string, unknown>): void {
		const message = typeof msg.message === "string" ? msg.message.trim() : "";
		if (!message) throw new Error("prompt message must be a non-empty string");
		const deliverAs = normalizeDeliveryMode(msg.streamingBehavior ?? msg.deliverAs);
		if (isIdle) {
			pi.sendUserMessage(message);
		} else {
			pi.sendUserMessage(message, { deliverAs });
		}
	}

	async function handleMessage(raw: string, conn: net.Socket, workspaceRoot: string): Promise<void> {
		const parsed: unknown = JSON.parse(raw);
		if (!isObject(parsed)) throw new Error("message must be an object");
		const type = parsed.type;

		if (type === "ping") {
			respond(conn, { ok: true, type: "pong", sessionId: latestCtx?.sessionManager.getSessionId(), idle: isIdle });
			return;
		}

		if (type === "context_sync" || type === "editor_update") {
			latestSnapshot = sanitizeSnapshot(parsed, workspaceRoot);
			latestContextDigest = contextDigest(latestSnapshot);
			updateStatus(latestSnapshot, latestCtx);
			respond(conn, { ok: true, type: "context_ack", seq: latestSnapshot.seq, summary: buildSummary(latestSnapshot) });
			return;
		}

		if (type === "get_context") {
			respond(conn, { ok: true, type: "context", snapshot: latestSnapshot, summary: buildSummary(latestSnapshot) });
			return;
		}

		if (type === "disconnect") {
			const clientId = typeof parsed.clientId === "string" ? parsed.clientId : undefined;
			if (!clientId || !latestSnapshot?.clientId || clientId === latestSnapshot.clientId) {
				latestSnapshot = undefined;
				latestContextDigest = undefined;
				lastSignaledContextDigest = undefined;
				lastInjectedSelectionDigest = undefined;
				updateStatus(undefined, latestCtx);
			}
			respond(conn, { ok: true, type: "disconnect_ack" });
			return;
		}

		if (type === "prompt") {
			handlePrompt(parsed);
			respond(conn, { ok: true, type: "prompt_queued", streamingBehavior: normalizeDeliveryMode(parsed.streamingBehavior ?? parsed.deliverAs), idle: isIdle });
			return;
		}

		throw new Error(`unknown message type: ${String(type)}`);
	}

	function startServer(ctx: ExtensionContext): void {
		cleanup();
		latestCtx = ctx;
		const workspaceRoot = findWorkspaceRoot(ctx.cwd);
		fs.mkdirSync(SOCKETS_DIR, { recursive: true });
		socketPath = socketPathFor(workspaceRoot);
		try {
			fs.unlinkSync(socketPath);
		} catch {}

		server = net.createServer((conn) => {
			let buffer = "";
			conn.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex !== -1) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line) {
						handleMessage(line, conn, workspaceRoot).catch((error: unknown) => {
							respond(conn, { ok: false, error: error instanceof Error ? error.message : String(error) });
						});
					}
					newlineIndex = buffer.indexOf("\n");
				}
			});
			conn.on("error", () => {});
		});

		server.on("error", (error) => {
			if (ctx.hasUI) ctx.ui.notify(`${PACKAGE_NAME}: ${error.message}`, "error");
		});

		server.listen(socketPath, () => {
			if (!socketPath) return;
			try {
				fs.unlinkSync(LATEST_LINK);
			} catch {}
			try {
				fs.symlinkSync(socketPath, LATEST_LINK);
			} catch {}
			writeManifest(ctx, workspaceRoot);
			if (ctx.hasUI) ctx.ui.notify(`${PACKAGE_NAME} socket: ${socketPath}`, "info");
		});
	}

	pi.registerTool({
		name: "editor_context",
		label: "Editor Context",
		description: "Inspect the current Neovim editor context synced by pi-nvim-bridge.",
		promptSnippet: "Inspect current Neovim buffer, cursor, selection, visible range, and diagnostics synced in the background.",
		promptGuidelines: [
			"Use editor_context when the user refers to the current Neovim buffer, cursor, selection, visible code, or diagnostics.",
		],
		parameters: Type.Object({
			include: Type.Optional(Type.String({ description: "One of: summary, selection, visible_range, diagnostics, all. Defaults to summary." })),
			maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes per text section.", minimum: 1000, maximum: 64000 })),
		}),
		async execute(_toolCallId, params) {
			const include = typeof params.include === "string" ? params.include : "summary";
			const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : DEFAULT_TOOL_MAX_BYTES;
			return {
				content: [{ type: "text" as const, text: formatToolContext(latestSnapshot, include, maxBytes) }],
				details: { snapshot: latestSnapshot },
			};
		},
	});

	pi.registerCommand("nvim-bridge-info", {
		description: "Show pi-nvim-bridge socket and last synced editor context",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${socketPath ?? "no socket"}\n${buildSummary(latestSnapshot)}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		isIdle = true;
		startServer(ctx);
		updateStatus(latestSnapshot, ctx);
	});

	pi.on("context", async (event) => {
		if (!latestSnapshot || !latestContextDigest || latestContextDigest === lastSignaledContextDigest) return;
		lastSignaledContextDigest = latestContextDigest;
		const contextSignal: (typeof event.messages)[number] = {
			role: "custom",
			customType: "pi-nvim-bridge-context-changed",
			content: buildContextChangedSignal(latestSnapshot),
			display: false,
			details: { digest: latestContextDigest, snapshotUpdatedAt: latestSnapshot.updatedAt },
			timestamp: Date.now(),
		};
		return { messages: [...event.messages, contextSignal] };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		const digest = selectionDigest(latestSnapshot);
		if (!digest) {
			lastInjectedSelectionDigest = undefined;
			return;
		}
		if (digest === lastInjectedSelectionDigest) return;
		const selectionContext = buildSelectionContext(latestSnapshot);
		if (!selectionContext) return;
		lastInjectedSelectionDigest = digest;
		return {
			message: {
				customType: "pi-nvim-bridge-selection",
				content: selectionContext,
				display: false,
				details: { digest, file: relativeFile(latestSnapshot), selection: latestSnapshot?.selection },
			},
		};
	});

	pi.on("agent_start", async () => {
		isIdle = false;
	});

	pi.on("agent_end", async () => {
		isIdle = true;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		updateStatus(undefined, ctx, { clear: true });
		cleanup();
	});

	process.once("exit", cleanup);
}
