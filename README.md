# pi-nvim-bridge

Automatic context bridge between [pi](https://github.com/badlogic/pi-mono) and Neovim.

This is a replacement for prompt-only `pi-nvim` style plugins. Neovim continuously syncs editor state to the active pi session without triggering LLM turns. Pi injects a compact summary into the next turn and exposes an `editor_context` tool for the full synced snapshot.

## What syncs

- active buffer path and filetype
- cursor line/column
- visual selection range and text
- visible window range and text
- buffer dirty/changedtick state
- Neovim diagnostics summary and first diagnostics

Explicit prompts sent from Neovim default to `steer` while pi is working.

## Install

### Pi side

```bash
pi install git:github.com/bnema/pi-nvim-bridge
```

For local development:

```bash
cd /home/brice/dev/projects/pi-nvim-bridge
npm install
pi -e .
```

### Neovim side

With lazy.nvim:

```lua
{
  "bnema/pi-nvim-bridge",
  config = function()
    require("pi-nvim-bridge").setup({
      default_streaming_behavior = "steer",
    })
  end,
}
```

For local development:

```lua
{
  dir = "/home/brice/dev/projects/pi-nvim-bridge",
  config = function()
    require("pi-nvim-bridge").setup()
  end,
}
```

## Commands

| Command | Description |
|---|---|
| `:PiNvimBridgeSync` | Force-sync current editor context |
| `:PiNvimBridgePrompt [text]` | Send a prompt with default streaming behavior (`steer`) |
| `:PiNvimBridgeSteer [text]` | Send prompt as steering message |
| `:PiNvimBridgeFollowUp [text]` | Queue prompt as follow-up |
| `:PiNvimBridgePing` | Ping the paired pi session |
| `:PiNvimBridgeSessions` | Pick a running pi session |

Default keymaps, if enabled:

| Key | Description |
|---|---|
| `<leader>p` | Prompt with editor context using default behavior |
| `<leader>ps` | Prompt as `steer` |
| `<leader>pf` | Prompt as `followUp` |

Disable them with:

```lua
require("pi-nvim-bridge").setup({ default_keymaps = false })
```

## Pi tool

The extension registers `editor_context` for the model:

```text
editor_context({ include = "summary" | "selection" | "visible_range" | "diagnostics" | "all" })
```

## Protocol

Pi publishes live sessions in:

```text
/tmp/pi-nvim-bridge-sockets/*.sock
/tmp/pi-nvim-bridge-sockets/*.sock.info
```

The manifest includes `workspaceRoot`, `cwd`, `sessionId`, `sessionFile`, `pid`, `socket`, and capability flags.

Neovim sends newline-delimited JSON over the Unix socket.

### Context sync

```json
{
  "type": "context_sync",
  "clientId": "nvim-123",
  "workspaceRoot": "/repo",
  "buffer": { "path": "/repo/main.go", "relativePath": "main.go", "filetype": "go", "dirty": true },
  "cursor": { "line": 42, "column": 9 },
  "selection": { "active": true, "startLine": 40, "endLine": 45, "text": "..." },
  "visibleRange": { "startLine": 20, "endLine": 70, "text": "..." },
  "diagnosticCounts": { "error": 0, "warning": 1, "info": 0, "hint": 2 }
}
```

Context sync only updates Pi-side bridge state. It does **not** trigger an LLM turn.

### Prompt

```json
{ "type": "prompt", "message": "look at current selection", "streamingBehavior": "steer" }
```

If pi is idle, this starts immediately. If pi is already processing, `streamingBehavior` maps to Pi's `deliverAs` option (`steer` or `followUp`).

## Design notes

- Discovery prefers exact `workspaceRoot`, then `cwd`, then most recent live session.
- Context updates are debounced and deduplicated in Neovim.
- Pi stores only the latest editor snapshot in memory.
- Prompt context is injected through `before_agent_start`; detailed text is available via `editor_context`.

## License

MIT
