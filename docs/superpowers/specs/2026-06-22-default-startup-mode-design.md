# Default Startup Permission Mode Design

Date: 2026-06-22

## Summary

The fork should start in the safer `default` permission mode unless the user explicitly configures or requests another mode. Upstream `@zackify/pi-claude-permissions` starts in `bypassPermissions`; this fork should intentionally diverge and make confirmation mode the package-level default.

## Goals

- Change the fork's built-in startup mode from `bypassPermissions` to `default`.
- Preserve all existing override mechanisms:
  - project/user `piClaudePermissions.defaultMode` settings;
  - legacy `permissions.json` mode/defaultMode config;
  - CLI `--permission-mode`;
  - CLI `--dangerously-skip-permissions`.
- Update documentation so examples and mode descriptions match the fork behavior.
- Avoid changing permission enforcement semantics for any mode.

## Non-goals

- Removing `bypassPermissions`.
- Changing `Shift+Tab` cycle order.
- Changing `/permissions` mode selection.
- Changing catastrophic/protected-path safety checks.
- Editing the user's local `~/.pi/agent/settings.json` to force a setting.

## Current State

The extension currently defines:

```ts
const DEFAULT_MODE: PermissionMode = "bypassPermissions";
```

Startup mode is then resolved with:

```ts
const defaultMode = normalizeMode(config.defaultMode, DEFAULT_MODE, modes);
let mode = normalizeMode(config.mode, defaultMode, modes);
```

During `session_start`, runtime flags can override this:

- `--dangerously-skip-permissions` sets mode to `bypassPermissions`.
- `--permission-mode <mode>` sets mode to the requested valid mode.

The README also documents `bypassPermissions` as the default mode and shows `defaultMode: "bypassPermissions"` in the sample config.

## Desired Behavior

Without any explicit config or CLI flag, the fork starts in:

```text
default
```

`default` mode means confirmation mode:

- prompts before write/edit/bash operations;
- keeps session-level approvals for prompted operations;
- still blocks protected paths and catastrophic commands.

Explicit overrides continue to work exactly as before. For example, a user can still opt into bypass startup globally or per project:

```json
{
  "piClaudePermissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

CLI overrides keep their current precedence:

```bash
pi --permission-mode plan
pi --permission-mode bypassPermissions
pi --dangerously-skip-permissions
```

## Implementation Design

Change only the built-in fallback constant:

```ts
const DEFAULT_MODE: PermissionMode = "default";
```

Update the file header comment so it no longer says bypass is the default startup mode.

Update README:

- Describe `default` as the fork's startup default.
- Remove “This is the default mode” from `bypassPermissions`.
- Set the configuration example to:

```json
{
  "piClaudePermissions": {
    "defaultMode": "default",
    "allowCatastrophic": false,
    "shiftTabOptions": ["default", "plan", "acceptEdits", "bypassPermissions"]
  }
}
```

- Note that users can set `defaultMode` to any valid built-in or custom mode if they want a different startup mode.

No changes are needed in `loadConfig()`, `normalizeMode()`, mode enforcement, or safety checks.

## Compatibility

Existing users who already set `piClaudePermissions.defaultMode` keep their configured behavior.

Users who relied on the package's implicit upstream default will see a behavior change: they will start in confirmation mode instead of bypass mode. This is intentional for this fork and should be documented clearly.

## Testing Plan

Automated/local checks:

```bash
npm run typecheck
npm run pack:dry
PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'
```

Manual TUI checks:

1. Remove or ignore any local `piClaudePermissions.defaultMode` setting.
2. Run `/reload` or restart pi with the local extension installed.
3. Confirm the active mode is `Default`.
4. Run `pi --permission-mode bypassPermissions` and confirm bypass still starts when explicitly requested.
5. Run `pi --dangerously-skip-permissions` and confirm bypass still starts when explicitly requested.
6. Set `piClaudePermissions.defaultMode` to `plan` and confirm config override still wins.

## Implementation Boundaries

Expected files:

- `extensions/index.ts`
- `README.md`

No permission enforcement logic should change.
