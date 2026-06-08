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

## Use

Select code in Neovim, then ask Pi about it. Or ask Pi to call `editor_context` for the latest synced snapshot.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
