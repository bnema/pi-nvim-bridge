local M = {}

local uv = vim.uv or vim.loop
local path_sep = package.config:sub(1, 1)

M.config = {
  socket_path = nil,
  sockets_dir = "/tmp/pi-nvim-bridge-sockets",
  debounce_ms = 180,
  default_streaming_behavior = "steer",
  auto_sync = true,
  include_visible_text = true,
  include_selection_text = true,
  include_diagnostics = true,
  include_codediff = true,
  max_visible_bytes = 12000,
  max_selection_bytes = 24000,
  default_keymaps = true,
}

M.state = {
  client_id = nil,
  selected_socket = nil,
  seq = 0,
  last_hash = nil,
  last_snapshot = nil,
  sync_timer = nil,
}

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = "pi-nvim-bridge" })
end

local function truncate_text(text, max_bytes)
  if not text or text == "" then
    return text, false
  end
  if #text <= max_bytes then
    return text, false
  end
  return text:sub(1, math.max(0, max_bytes - 2)) .. "…", true
end

local function current_cwd()
  return uv.cwd()
end

local function workspace_root()
  local buf_name = vim.api.nvim_buf_get_name(0)
  local codediff_root = buf_name:match("^codediff:///(.-)///")
  if codediff_root then
    return codediff_root ~= "" and codediff_root or "/"
  end
  local start = buf_name ~= "" and vim.fs.dirname(buf_name) or current_cwd()
  local root = vim.fs.root(start, { ".git" })
  return root or current_cwd()
end

local function read_json_file(path)
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok or not lines or not lines[1] then
    return nil
  end
  local decode_ok, parsed = pcall(vim.json.decode, table.concat(lines, "\n"))
  if decode_ok then
    return parsed
  end
  return nil
end

local function socket_alive(socket)
  return socket and uv.fs_stat(socket) ~= nil
end

function M.list_sessions()
  local ok, files = pcall(vim.fn.glob, M.config.sockets_dir .. "/*.info", false, true)
  if not ok or not files then
    return {}
  end

  local sessions = {}
  for _, info_path in ipairs(files) do
    local info = read_json_file(info_path)
    local socket = info and (info.socket or info_path:sub(1, -6)) or nil
    if info and socket_alive(socket) then
      local stat = uv.fs_stat(socket)
      table.insert(sessions, {
        socket = socket,
        cwd = info.cwd,
        workspaceRoot = info.workspaceRoot or info.cwd,
        sessionId = info.sessionId,
        sessionFile = info.sessionFile,
        pid = info.pid,
        startedAt = info.startedAt,
        mtime = stat and stat.mtime and stat.mtime.sec or 0,
      })
    end
  end
  table.sort(sessions, function(a, b)
    return (a.mtime or 0) > (b.mtime or 0)
  end)
  return sessions
end

function M.get_socket_path()
  if M.config.socket_path then
    return M.config.socket_path
  end
  if M.state.selected_socket and socket_alive(M.state.selected_socket) then
    return M.state.selected_socket
  end

  local root = workspace_root()
  local cwd = current_cwd()
  local sessions = M.list_sessions()

  for _, session in ipairs(sessions) do
    if session.workspaceRoot == root then
      return session.socket
    end
  end
  for _, session in ipairs(sessions) do
    if session.cwd == cwd then
      return session.socket
    end
  end
  if sessions[1] then
    return sessions[1].socket
  end

  local latest = "/tmp/pi-nvim-bridge-latest.sock"
  if socket_alive(latest) then
    return latest
  end
  return nil
end

function M.send_raw(msg, cb)
  local socket_path = M.get_socket_path()
  if not socket_path then
    local err = "No pi-nvim-bridge session found. Is pi running with the extension?"
    if cb then
      cb(err, nil)
    else
      notify(err, vim.log.levels.ERROR)
    end
    return
  end

  local client = uv.new_pipe(false)
  if not client then
    local err = "Failed to create pipe"
    if cb then cb(err, nil) end
    return
  end

  client:connect(socket_path, function(connect_err)
    if connect_err then
      pcall(function() client:close() end)
      vim.schedule(function()
        if cb then cb(connect_err, nil) else notify("Failed to connect to pi: " .. connect_err, vim.log.levels.ERROR) end
      end)
      return
    end

    client:write(vim.json.encode(msg) .. "\n")
    local buf = ""
    client:read_start(function(read_err, data)
      if read_err then
        pcall(function() client:close() end)
        vim.schedule(function()
          if cb then cb(read_err, nil) end
        end)
        return
      end
      if data then
        buf = buf .. data
        local nl = buf:find("\n", 1, true)
        if nl then
          local line = buf:sub(1, nl - 1)
          pcall(function() client:read_stop() end)
          pcall(function() client:close() end)
          vim.schedule(function()
            local ok, resp = pcall(vim.json.decode, line)
            if ok then
              if cb then cb(nil, resp) end
            elseif cb then
              cb("Invalid response from pi", nil)
            end
          end)
        end
      else
        pcall(function() client:close() end)
      end
    end)
  end)
end

local function line_range_text(bufnr, start_line, end_line, max_bytes)
  if start_line <= 0 or end_line <= 0 or end_line < start_line then
    return nil, false
  end
  local lines = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, end_line, false)
  local text = table.concat(lines, "\n")
  return truncate_text(text, max_bytes)
end

local function capture_selection(bufnr, mode)
  if not (mode == "v" or mode == "V" or mode == "\022") then
    return { active = false }
  end

  local start_pos = vim.fn.getpos("v")
  local end_pos = vim.fn.getpos(".")
  if start_pos[2] == 0 or end_pos[2] == 0 then
    return { active = false }
  end

  local start_line = math.min(start_pos[2], end_pos[2])
  local end_line = math.max(start_pos[2], end_pos[2])
  local text, truncated = nil, false

  if M.config.include_selection_text then
    local ok, lines = pcall(vim.fn.getregion, start_pos, end_pos, { type = mode })
    if ok and lines and #lines > 0 then
      text, truncated = truncate_text(table.concat(lines, "\n"), M.config.max_selection_bytes)
    else
      text, truncated = line_range_text(bufnr, start_line, end_line, M.config.max_selection_bytes)
    end
  end

  return {
    active = true,
    startLine = start_line,
    endLine = end_line,
    text = text,
    textTruncated = truncated,
  }
end

local severity_names = {
  [vim.diagnostic.severity.ERROR] = "error",
  [vim.diagnostic.severity.WARN] = "warning",
  [vim.diagnostic.severity.INFO] = "info",
  [vim.diagnostic.severity.HINT] = "hint",
}

local function collect_diagnostics(bufnr)
  if not M.config.include_diagnostics or not vim.diagnostic then
    return nil, nil
  end
  local diagnostics = vim.diagnostic.get(bufnr)
  local counts = { error = 0, warning = 0, info = 0, hint = 0 }
  local items = {}
  for _, diagnostic in ipairs(diagnostics) do
    local severity = severity_names[diagnostic.severity] or "diagnostic"
    counts[severity] = (counts[severity] or 0) + 1
    if #items < 25 then
      table.insert(items, {
        line = (diagnostic.lnum or 0) + 1,
        column = (diagnostic.col or 0) + 1,
        severity = severity,
        message = diagnostic.message,
        source = diagnostic.source,
      })
    end
  end
  return items, counts
end

local function is_abs_path(value)
  return type(value) == "string" and (value:sub(1, 1) == "/" or value:match("^%a:[/\\]"))
end

local function join_root_path(root, rel)
  if not rel or rel == "" then
    return nil
  end
  if is_abs_path(rel) then
    return rel
  end
  if root and root ~= "" then
    local last = root:sub(-1)
    local separator = (last == "/" or last == "\\") and "" or path_sep
    return root .. separator .. rel
  end
  return rel
end

local function copy_range(range)
  if not range then return nil end
  return {
    startLine = range.start_line,
    endLineExclusive = range.end_line,
  }
end

local function range_overlaps(selection_start, selection_end, hunk_range)
  if not hunk_range or not hunk_range.start_line or not hunk_range.end_line then
    return false
  end
  return selection_start < hunk_range.end_line and selection_end >= hunk_range.start_line
end

local function collect_codediff_context(bufnr, selection, cursor_line)
  if not M.config.include_codediff then
    return nil
  end
  local ok, lifecycle = pcall(require, "codediff.ui.lifecycle")
  if not ok or not lifecycle then
    return nil
  end

  local tabpage = nil
  if lifecycle.find_tabpage_by_buffer then
    tabpage = lifecycle.find_tabpage_by_buffer(bufnr)
  end
  tabpage = tabpage or vim.api.nvim_get_current_tabpage()

  local session = lifecycle.get_session and lifecycle.get_session(tabpage) or nil
  if not session then
    return nil
  end

  local side
  if bufnr == session.original_bufnr then
    side = "original"
  elseif bufnr == session.modified_bufnr then
    side = "modified"
  elseif bufnr == session.result_bufnr then
    side = "result"
  else
    return nil
  end

  local current_path, current_revision
  if side == "original" then
    current_path = session.original_path
    current_revision = session.original_revision
  elseif side == "modified" then
    current_path = session.modified_path
    current_revision = session.modified_revision
  else
    current_path = session.modified_path or session.original_path
    current_revision = "WORKING"
  end

  local start_line = selection and selection.active and selection.startLine or cursor_line
  local end_line = selection and selection.active and selection.endLine or cursor_line
  local hunks = {}
  local diff_result = session.stored_diff_result or {}
  for index, hunk in ipairs(diff_result.changes or {}) do
    local side_range = side == "original" and hunk.original or hunk.modified
    if side == "result" then
      side_range = hunk.modified
    end
    if range_overlaps(start_line, end_line, side_range) then
      table.insert(hunks, {
        index = index,
        original = copy_range(hunk.original),
        modified = copy_range(hunk.modified),
        opposite = side == "original" and copy_range(hunk.modified) or copy_range(hunk.original),
      })
      if #hunks >= 50 then
        break
      end
    end
  end

  return {
    active = true,
    mode = session.mode,
    layout = session.layout,
    side = side,
    gitRoot = session.git_root,
    originalPath = session.original_path,
    modifiedPath = session.modified_path,
    originalRevision = session.original_revision,
    modifiedRevision = session.modified_revision,
    currentPath = current_path,
    currentAbsolutePath = join_root_path(session.git_root, current_path),
    currentRevision = current_revision,
    selectedLineRange = {
      startLine = start_line,
      endLine = end_line,
    },
    hunks = hunks,
  }
end

function M.snapshot(reason)
  local bufnr = vim.api.nvim_get_current_buf()
  local path = vim.api.nvim_buf_get_name(bufnr)
  local root = workspace_root()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local mode = vim.fn.mode()
  local w0 = vim.fn.line("w0")
  local wend = vim.fn.line("w$")
  local visible_text, visible_truncated = nil, false

  if M.config.include_visible_text then
    visible_text, visible_truncated = line_range_text(bufnr, w0, wend, M.config.max_visible_bytes)
  end

  local diagnostics, diagnostic_counts = collect_diagnostics(bufnr)
  local selection = capture_selection(bufnr, mode)
  local codediff = collect_codediff_context(bufnr, selection, cursor[1])

  M.state.seq = M.state.seq + 1
  return {
    type = "context_sync",
    clientId = M.state.client_id,
    seq = M.state.seq,
    reason = reason or "unknown",
    cwd = current_cwd(),
    workspaceRoot = root,
    mode = mode,
    buffer = {
      path = path ~= "" and path or nil,
      relativePath = path ~= "" and vim.fn.fnamemodify(path, ":.") or nil,
      filetype = vim.bo[bufnr].filetype,
      dirty = vim.bo[bufnr].modified,
      changedtick = vim.b[bufnr].changedtick,
      lineCount = vim.api.nvim_buf_line_count(bufnr),
    },
    cursor = {
      line = cursor[1],
      column = cursor[2] + 1,
    },
    selection = selection,
    visibleRange = {
      startLine = w0,
      endLine = wend,
      text = visible_text,
      textTruncated = visible_truncated,
    },
    diagnostics = diagnostics,
    diagnosticCounts = diagnostic_counts,
    codediff = codediff,
  }
end

local function snapshot_hash(snapshot)
  local ok, encoded = pcall(vim.json.encode, snapshot)
  if not ok then
    return tostring(vim.loop.hrtime())
  end
  if vim.fn.exists("*sha256") == 1 then
    return vim.fn.sha256(encoded)
  end
  return encoded
end

function M.sync(reason, opts)
  opts = opts or {}
  local snapshot = M.snapshot(reason)
  local hash = snapshot_hash(snapshot)
  if not opts.force and hash == M.state.last_hash then
    if opts.on_done then opts.on_done(nil, nil) end
    return
  end
  M.state.last_hash = hash
  M.state.last_snapshot = snapshot
  M.send_raw(snapshot, function(err, resp)
    if err then
      if opts.notify_errors then notify(err, vim.log.levels.ERROR) end
      if opts.on_done then opts.on_done(err, resp) end
      return
    end
    if resp and resp.ok == false and opts.notify_errors then
      notify(resp.error or "pi rejected context sync", vim.log.levels.ERROR)
    end
    if opts.on_done then opts.on_done(err, resp) end
  end)
end

function M.schedule_sync(reason)
  if not M.config.auto_sync then
    return
  end
  if not M.state.sync_timer then
    M.state.sync_timer = uv.new_timer()
  end
  M.state.sync_timer:stop()
  M.state.sync_timer:start(M.config.debounce_ms, 0, vim.schedule_wrap(function()
    M.sync(reason)
  end))
end

local function send_prompt(message, streaming_behavior)
  M.send_raw({ type = "prompt", message = message, streamingBehavior = streaming_behavior or M.config.default_streaming_behavior }, function(err, resp)
    if err then
      notify(err, vim.log.levels.ERROR)
      return
    end
    if resp and resp.ok then
      notify("Sent to pi (" .. (streaming_behavior or M.config.default_streaming_behavior) .. ")")
    else
      notify("pi error: " .. (resp and resp.error or "unknown"), vim.log.levels.ERROR)
    end
  end)
end

local function with_synced_prompt_context(callback)
  M.sync("prompt", {
    force = true,
    notify_errors = true,
    on_done = function()
      callback()
    end,
  })
end

local function prompt_input(title, streaming_behavior)
  with_synced_prompt_context(function()
    vim.ui.input({ prompt = title or "Pi prompt: " }, function(input)
      if not input or input == "" then
        return
      end
      send_prompt(input, streaming_behavior)
    end)
  end)
end

function M.prompt(message, streaming_behavior)
  if not message or message == "" then
    prompt_input("Pi prompt: ", streaming_behavior)
    return
  end
  with_synced_prompt_context(function()
    send_prompt(message, streaming_behavior)
  end)
end

function M.ping()
  M.send_raw({ type = "ping" }, function(err, resp)
    if err then
      notify("Pi not reachable: " .. err, vim.log.levels.ERROR)
    elseif resp and resp.type == "pong" then
      notify("Pi is alive: " .. (resp.sessionId or "unknown session"))
    else
      notify("Unexpected response from pi", vim.log.levels.WARN)
    end
  end)
end

function M.disconnect(reason)
  if M.state.sync_timer then
    M.state.sync_timer:stop()
  end

  local socket_path = M.get_socket_path()
  if not socket_path then
    return
  end
  local payload = vim.json.encode({ type = "disconnect", clientId = M.state.client_id, reason = reason or "disconnect" }) .. "\n"

  local ok, chan = pcall(vim.fn.sockconnect, "pipe", socket_path, { rpc = false })
  if ok and type(chan) == "number" and chan > 0 then
    pcall(vim.fn.chansend, chan, payload)
    pcall(vim.fn.chanclose, chan)
    return
  end

  M.send_raw({ type = "disconnect", clientId = M.state.client_id, reason = reason or "disconnect" }, function() end)
end

function M.select_session()
  local sessions = M.list_sessions()
  if #sessions == 0 then
    notify("No pi-nvim-bridge sessions found", vim.log.levels.WARN)
    return
  end
  local items = {}
  for _, session in ipairs(sessions) do
    table.insert(items, string.format("%s [pid %s] %s", session.workspaceRoot or session.cwd or "?", session.pid or "?", session.sessionId or ""))
  end
  vim.ui.select(items, { prompt = "Pi sessions:" }, function(_, idx)
    if not idx then return end
    M.state.selected_socket = sessions[idx].socket
    notify("Connected to " .. (sessions[idx].workspaceRoot or sessions[idx].cwd or sessions[idx].socket))
    M.sync("session-select", { force = true, notify_errors = true })
  end)
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  M.state.client_id = M.state.client_id or ("nvim-" .. tostring(uv.getpid()) .. "-" .. tostring(math.floor(uv.hrtime() % 1000000)))

  vim.api.nvim_create_user_command("PiNvimBridgeSync", function()
    M.sync("manual", { force = true, notify_errors = true })
  end, { desc = "Sync current Neovim context to pi" })

  vim.api.nvim_create_user_command("PiNvimBridgePrompt", function(args)
    M.prompt(args.args, M.config.default_streaming_behavior)
  end, { nargs = "*", desc = "Send prompt to pi with synced editor context" })

  vim.api.nvim_create_user_command("PiNvimBridgeSteer", function(args)
    M.prompt(args.args, "steer")
  end, { nargs = "*", desc = "Send steering prompt to pi" })

  vim.api.nvim_create_user_command("PiNvimBridgeFollowUp", function(args)
    M.prompt(args.args, "followUp")
  end, { nargs = "*", desc = "Send follow-up prompt to pi" })

  vim.api.nvim_create_user_command("PiNvimBridgePing", function()
    M.ping()
  end, { desc = "Ping active pi-nvim-bridge session" })

  vim.api.nvim_create_user_command("PiNvimBridgeSessions", function()
    M.select_session()
  end, { desc = "Select active pi session" })

  local group = vim.api.nvim_create_augroup("PiNvimBridge", { clear = true })
  vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter", "CursorMoved", "CursorMovedI", "ModeChanged", "TextChanged", "TextChangedI", "WinScrolled", "DiagnosticChanged" }, {
    group = group,
    callback = function(args)
      M.schedule_sync(args.event)
    end,
  })

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = group,
    callback = function(args)
      M.disconnect(args.event)
    end,
  })

  if M.config.default_keymaps then
    vim.keymap.set({ "n", "v" }, "<leader>p", function() M.prompt(nil, M.config.default_streaming_behavior) end, { desc = "Pi: prompt with editor context" })
    vim.keymap.set({ "n", "v" }, "<leader>ps", function() M.prompt(nil, "steer") end, { desc = "Pi: steer with editor context" })
    vim.keymap.set({ "n", "v" }, "<leader>pf", function() M.prompt(nil, "followUp") end, { desc = "Pi: follow-up with editor context" })
  end

  M.schedule_sync("setup")
end

return M
