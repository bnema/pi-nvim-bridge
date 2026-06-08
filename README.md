# pi-nvim-bridge

Sync Neovim editor context into active Pi sessions.

## What it does

- Sends active buffer, cursor, visual selection, visible range, dirty state, and diagnostics to Pi.
- Injects the active visual selection into the next Pi turn once.
- Adds the `editor_context` tool for explicit inspection.
- Optionally enriches context from `codediff.nvim` review buffers.

## Install

Install the Pi extension:

```bash
pi install git:github.com/bnema/pi-nvim-bridge
```

Install the Neovim side with `lazy.nvim`:

```lua
{
  "bnema/pi-nvim-bridge",
  event = { "BufReadPost", "BufNewFile" },
  config = function()
    require("pi-nvim-bridge").setup({
      default_streaming_behavior = "steer",
    })
  end,
}
```

## Commands

Neovim commands:

```vim
:PiNvimBridgeSync
:PiNvimBridgePrompt <message>
:PiNvimBridgeSteer <message>
:PiNvimBridgeFollowUp <message>
:PiNvimBridgePing
:PiNvimBridgeSessions
```

## Pi tool

Use `editor_context` to inspect the latest synced snapshot:

```json
{
  "include": "summary",
  "maxBytes": 12000
}
```

`include` can request summary, selection, visible range, diagnostics, or all available context.

## Protocol notes

The Neovim side discovers active Pi sessions from `/tmp/pi-nvim-bridge-sockets/*.info`. It sends newline-delimited JSON messages for `context_sync`, `prompt`, `get_context`, `ping`, and `disconnect`. Context sync does not trigger an LLM turn; prompts do.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
