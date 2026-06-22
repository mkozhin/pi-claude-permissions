# pi-claude-permissions (personal fork)

![pi-claude-permissions gallery preview](./gallery.png)

Personal fork of [`@zackify/pi-claude-permissions`](https://github.com/zackify/pi-claude-permissions): Claude-style permissions for [pi](https://pi.dev), with configurable mode cycling and built-in plan mode.

Upstream is preserved as the `upstream` git remote so we can pull fixes later, while this repo evolves under `@mkozhin/pi-claude-permissions`.

## What this extension does

- Adds permission modes inspired by Claude Code.
- Shows current mode in the Pi status line and can publish a `pi-powerbar` segment.
- Lets `Shift+Tab` cycle modes.
- Adds `/permissions` for manual mode selection.
- Adds read-only `plan` mode that injects planning instructions.
- Keeps always-on safety checks for catastrophic commands and protected paths.

## Modes

### `default`

Confirmation mode.

- Prompts before every tool call.
- Keeps session-level approvals for prompted operations.
- Still blocks protected paths and catastrophic commands.
- This is the startup default for this fork.

### `plan`

Read-only exploration mode.

Allowed tools:

- `read`
- `bash` when the command looks read-only
- `grep`
- `find`
- `ls`
- `rg`
- `fd`
- `bat`
- `eza`
- selected `mcp` servers if configured

Blocked in plan mode:

- `edit`
- `write`
- mutating bash commands
- anything outside the read/search allowlist

When entering plan mode, the extension notifies:

```text
In plan mode, only read files/search tools are allowed.
```

It also injects visible planning instructions into the next agent turn so the model knows to inspect only and produce a detailed plan.

### `acceptEdits`

- Allows `write` and `edit` automatically.
- Prompts for bash commands.
- Still blocks protected paths and catastrophic commands.

### `bypassPermissions`

- Allows normal operations without confirmation.
- Still blocks catastrophic commands and protected paths.

## Installation for local development

From this checkout:

```bash
pi install ./
```

Then restart pi or run `/reload` inside pi.

For one-off testing without adding it to settings:

```bash
pi -e ./
```

If/when this fork is published or pushed to GitHub, it can also be installed as a normal pi package:

```bash
pi install git:github.com/mkozhin/pi-claude-permissions
# or, if published to npm:
pi install npm:@mkozhin/pi-claude-permissions
```

## Configuration

Set this in `~/.pi/agent/settings.json` or project-local `.pi/settings.json`:

```json
{
  "piClaudePermissions": {
    "defaultMode": "default",
    "allowCatastrophic": false,
    "shiftTabOptions": ["default", "plan", "acceptEdits", "bypassPermissions"],
    "hideDefaultMode": false,
    "planModeAllowedMcpServers": []
  }
}
```

`defaultMode` controls the startup mode and defaults to `default` in this fork. Valid built-in values are `default`, `plan`, `acceptEdits`, and `bypassPermissions`. Set it explicitly if you want a different startup mode.

`allowCatastrophic` defaults to `false`. When set to `true`, catastrophic command blocking and critical `rm -rf` detection are allowed. Protected path checks still run.

`shiftTabOptions` controls only the `Shift+Tab` cycle. `/permissions` still lists every mode.

`hideDefaultMode` hides the footer/status indicator when the active mode equals the configured default.

`planModeAllowedMcpServers` allows specific MCP servers during plan mode.

## Powerbar visibility

If you use [`@juanibiapina/pi-powerbar`](https://github.com/juanibiapina/pi-powerbar), this extension registers a `Permissions` segment with id `permissions` and keeps it updated with the active mode.

The segment is not enabled automatically. To show it, run:

```text
/extension-settings → powerbar → Left segments / Right segments → Permissions
```

The segment uses the same short Claude-like labels as the built-in status fallback:

| Mode | Display |
| --- | --- |
| `default` | `⏵ Default` |
| `plan` | `⏸ Plan` |
| `acceptEdits` | `⏵⏵ Accept Edits` |
| `bypassPermissions` | `⏵⏵⏵⏵ Bypass` |

The extension also supports `customModes` for project-specific policies. We can shape this further as our needs become clear.

## Development

```bash
npm install
npm run typecheck
npm run pack:dry
```

Useful local loop:

1. Edit `extensions/index.ts`.
2. Run `npm run typecheck`.
3. Run `/reload` in pi if installed via `pi install ./`, or restart the `pi -e ./` test session.

## Fork notes

- Upstream: [`zackify/pi-claude-permissions`](https://github.com/zackify/pi-claude-permissions)
- Inspired by: [`rHedBull/pi-permissions`](https://github.com/rHedBull/pi-permissions)
- Package key remains `piClaudePermissions` for compatibility with upstream config.

## License

MIT. See [LICENSE](./LICENSE).
