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

Day-to-day confirmation mode.

- Allows ordinary bounded read/search/list operations without confirmation: `read`, `grep`, `find`, `ls`, `rg`, `fd`, `bat`, `eza`, and safe read-only `bash` commands such as `ls`, file-specific `grep`/`rg`, `cat`, and `git status`.
- Broad directory searches may still prompt when they could sweep likely-secret files, including `grep`/`rg` over `.` without a safe narrowing glob and `find`/`fd` calls without a concrete name or pattern.
- Default auto-approves only simple read-only bash syntax. It prompts for shell chaining, command substitution, redirection, write-capable options, recursive `grep`, broad `rg`, hidden/unrestricted `fd`, and diff-producing or pager/config-sensitive Git commands such as `git diff`, `git log`, and `git show`.
- Prompts before reading likely-secret paths such as `.env*`, `.ssh`, `.aws`, `.gnupg`, `.gpg`, `.kube`, `.docker`, `.npmrc`, `.netrc`, and credential/token/secret/private-key/auth-named files.
- Allows workflow tools `manage_todo_list` and `ask_user` without confirmation.
- Prompts before `write`, `edit`, mutating or suspicious `bash` commands, and any other tool outside the read/search/list and workflow allowlists.
- Keeps session-level approvals for prompted operations.
- Still blocks catastrophic commands. Bash/write/edit operations targeting configured protected paths are blocked before confirmation and cannot be session-approved.
- This is the startup default for this fork.

### `strict`

Strongest confirmation mode.

- Prompts before almost every tool call, matching the old broad-prompt `default` behavior.
- Keeps session-level approvals for prompted operations.
- Still blocks catastrophic bash commands and bash/write/edit operations targeting configured protected paths before confirmation.
- Use this when you want maximum confirmation instead of the more practical day-to-day `default` mode.

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
    "shiftTabOptions": ["default", "plan", "acceptEdits", "bypassPermissions", "strict"],
    "hideDefaultMode": false,
    "planModeAllowedMcpServers": []
  }
}
```

`defaultMode` controls the startup mode and defaults to `default` in this fork. Valid built-in values are `default`, `plan`, `acceptEdits`, `bypassPermissions`, and `strict`. Set it explicitly if you want a different startup mode.

You can also override the startup mode for a pi process with `--permission-mode strict`. Valid flag values are `default`, `plan`, `acceptEdits`, `bypassPermissions`, and `strict`.

`allowCatastrophic` defaults to `false`. When set to `true`, catastrophic command blocking and critical `rm -rf` detection are allowed. Protected path checks still run.

`shiftTabOptions` controls only the `Shift+Tab` cycle. If you omit it, the default cycle includes every built-in mode, including `strict`. If you configure it yourself, include `strict` there if you want it in the cycle. `/permissions` still lists and can select every mode, including `strict`.

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
| `strict` | `⏵! Strict` |

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
