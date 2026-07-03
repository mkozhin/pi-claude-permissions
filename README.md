# pi-claude-permissions

![pi-claude-permissions gallery preview](./gallery.png)

Fork of [`@zackify/pi-claude-permissions`](https://github.com/zackify/pi-claude-permissions): Claude-style permissions for [pi](https://pi.dev), with configurable mode cycling and built-in plan mode.

Upstream is preserved as the `upstream` git remote so we can pull fixes later, while this repo evolves under `@mkozhin/pi-claude-permissions`.

## What this extension does

- Adds permission modes inspired by Claude Code.
- Shows current mode in the Pi status line and can publish a `pi-powerbar` segment.
- Lets `Shift+Tab` cycle modes.
- Adds `/permissions` for manual mode selection.
- Adds read-only `plan` mode that injects planning instructions.
- Keeps always-on safety checks for catastrophic commands and protected paths.
- Approval confirmation dialogs support numbered quick-pick: press `1`-`9` to instantly choose an option, in addition to the usual arrow keys + Enter.

## Modes

### `default`

Day-to-day confirmation mode.

- Allows ordinary bounded read/search/list operations without confirmation: `read`, `grep`, `find`, `ls`, `rg`, `fd`, `bat`, `eza`, and safe read-only `bash` commands such as `ls`, file-specific `grep`/`rg`, `cat`, and `git status`.
- Broad directory searches/lists may still prompt when they could sweep likely-secret files or expose home/root structure, including `grep`/`rg` over `.` without a safe narrowing glob, `find`/`fd` calls without a concrete name or pattern, and direct list/search roots such as `/` or `~`.
- Default auto-approves only simple read-only bash syntax, including simple pipelines when every segment is an allowed read-only command. It prompts for control-flow chaining, command substitution, redirection other than `2>/dev/null`, write-capable options, recursive `grep`, broad `rg`, hidden/unrestricted `fd`, and diff-producing or pager/config-sensitive Git commands such as `git diff`, `git log`, `git show`, and `git config`.
- Prompts before reading likely-secret paths such as `.env*`, `.ssh`, `.aws`, `.gnupg`, `.gpg`, `.kube`, `.docker`, `.npmrc`, `.netrc`, and credential/token/secret/private-key/auth-named files. This also applies when a read/search/list tool or defaulting bash command would read from a likely-secret current working directory.
- Direct read/search/list calls that reference configured protected paths also prompt in `default`; bash/write/edit references to protected paths remain hard-blocked before confirmation and cannot be session-approved.
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
- `bash` when the command matches the conservative read-only allowlist
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

Plan-mode bash uses a fixed allowlist of simple read/list/search/status commands plus explicit read-only GitHub, git, and npm metadata commands. Generic `curl`, `sed`, `awk`, `env`, and generic `gh api` are not plan-safe. Commands with output-writing options, command substitution, control-flow chaining, `find`/`fd` exec or delete options, `rg --pre`, unsafe `bat` pager/config options, `git --output`/`--ext-diff`/`--textconv`, or special device reads are blocked.

Catastrophic bash commands and bash/write/edit operations targeting configured protected paths are blocked before plan-mode allow or deny handling.

When entering plan mode, the extension notifies:

```text
In plan mode, only read files/search tools are allowed.
```

It also injects visible planning instructions into the next agent turn so the model knows to inspect only and produce a detailed plan.

### `acceptEdits`

- Allows `write` and `edit` automatically.
- Prompts for bash commands.
- Still blocks catastrophic bash and bash/write/edit operations targeting configured protected paths. Direct read/search/list calls are not hard-blocked in this mode.

### `bypassPermissions`

- Allows normal operations without confirmation.
- Still blocks catastrophic bash and bash/write/edit operations targeting configured protected paths. Direct read/search/list calls are not hard-blocked in this mode.

## Approval dialog

Whenever a tool call needs confirmation, the extension shows a numbered choice dialog (e.g. `1. Allow once`, `2. Allow this command for session` / `Allow all <tool> for session`, `3. Deny`):

- Press `1`-`9` to instantly pick the matching option — no need to press Enter.
- Arrow Up/Down still moves the highlighted option (with wrap-around), PageUp/PageDown jump to the first/last option, and Enter confirms whichever option is highlighted.
- `Esc` or Ctrl+C still means Deny.
- Navigation/confirm/cancel honor your configured `tui.select.*` keybindings (same as the host's own select dialog) if you've remapped them; digits 1-9 are always the literal number keys.
- Digits outside the number of available options are ignored; the dialog stays open.
- This numbered dialog is a TUI-only enhancement. When the host isn't running in interactive TUI mode (e.g. RPC mode), approval prompts fall back to the host's plain `select()` dialog instead, so non-TUI clients (IDE integrations, automation) can still answer them.

This applies to approval/confirmation prompts only. The `Select permission mode` picker (`Shift+Tab` / `/permissions`) is unchanged and still uses arrow keys + Enter.

## Installation

Install directly from GitHub — no npm account or publishing required:

```bash
pi install git:github.com/mkozhin/pi-claude-permissions
```

This clones the repo to `~/.pi/agent/git/github.com/mkozhin/pi-claude-permissions` (or `.pi/git/...` with `-l` for a project-local install) and runs `npm install` automatically. Restart pi or run `/reload` afterward.

Pin to a specific tag or commit if you want a stable, non-moving version:

```bash
pi install git:github.com/mkozhin/pi-claude-permissions@v0.1.0
```

Without a pinned ref, `pi update --extensions` (or `pi update --all`) pulls the latest commit on the default branch.

### Local development

Working on this repo itself? Install straight from your checkout:

```bash
pi install ./
```

Then restart pi or run `/reload` inside pi.

For one-off testing without adding it to settings:

```bash
pi -e ./
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

`--dangerously-skip-permissions` starts the session in `bypassPermissions`. Catastrophic bash checks and bash/write/edit protected-path checks still run.

`allowCatastrophic` defaults to `false`. When set to `true`, catastrophic command blocking and critical `rm -rf` detection are allowed. Protected path checks still run.

`shiftTabOptions` controls only the `Shift+Tab` cycle. If you omit it, the default cycle includes every built-in mode, including `strict`. If you configure it yourself, include `strict` there if you want it in the cycle. `/permissions` still lists and can select every mode, including `strict`.

`hideDefaultMode` hides the footer/status indicator when the active mode equals the configured default.

`planModeAllowedMcpServers` allows specific MCP servers during plan mode.

Additional permission policy can be set in `~/.pi/agent/extensions/permissions.json` or project-local `.pi/extensions/permissions.json`. These files support `mode`, `protectedPaths`, `dangerousPatterns`, `catastrophicPatterns`, `allowCatastrophic`, `shiftTabOptions`, `defaultMode`, `hideDefaultMode`, `planModeAllowedMcpServers`, and `customModes`.

Precedence:

- `--dangerously-skip-permissions` overrides startup mode to `bypassPermissions`.
- `--permission-mode` overrides the configured startup mode.
- For `defaultMode`, `shiftTabOptions`, `hideDefaultMode`, `planModeAllowedMcpServers`, `customModes`, and `allowCatastrophic`: project settings > global settings > project permissions file > global permissions file.
- For `mode`, `protectedPaths`, `dangerousPatterns`, and `catastrophicPatterns`: project permissions file > global permissions file.

`protectedPaths` defaults to sensitive home paths such as `~/.ssh`, `~/.aws`, shell profiles, package credentials, Docker/Kube config, and Pi auth. In `default`, direct read/search/list references to protected paths prompt for confirmation; bash/write/edit references are blocked before confirmation in every mode.

`dangerousPatterns` and `catastrophicPatterns` are string patterns checked in bash commands. Dangerous matches add warning text to the confirmation prompt; catastrophic matches are blocked unless `allowCatastrophic` is true.

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

The extension also supports `customModes` for project-specific policies:

```json
{
  "customModes": [
    {
      "id": "projectSafe",
      "label": "Project Safe",
      "status": "P",
      "description": "Allow project writes and limited localhost access",
      "policy": {
        "excludedTools": ["browser"],
        "allowedWriteRoots": ["cwd", "parent", "~/scratch", "/tmp/project-output"],
        "blockedBashPatterns": [
          { "pattern": "deploy", "description": "deployment commands require confirmation" }
        ],
        "network": {
          "allowLocalhostOnly": true,
          "allowedPorts": [3000, 5173]
        }
      }
    }
  ]
}
```

Relative write/edit paths are resolved against the Pi session `cwd`. Custom modes cannot override the always-on catastrophic command checks or protected-path blocks for bash/write/edit operations. Those checks run before custom policies, bypass mode, and session approvals.

## Development

```bash
npm install
npm run test
npm run typecheck
npm run pack:dry
```

Useful local loop:

1. Edit `extensions/index.ts`.
2. Run `npm run test`.
3. Run `npm run typecheck`.
4. Run `/reload` in pi if installed via `pi install ./`, or restart the `pi -e ./` test session.

## Fork notes

- Upstream: [`zackify/pi-claude-permissions`](https://github.com/zackify/pi-claude-permissions)
- Inspired by: [`rHedBull/pi-permissions`](https://github.com/rHedBull/pi-permissions)
- Package key remains `piClaudePermissions` for compatibility with upstream config.

## License

MIT. See [LICENSE](./LICENSE).
