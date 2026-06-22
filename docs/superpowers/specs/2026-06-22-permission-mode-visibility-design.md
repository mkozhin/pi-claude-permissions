# Permission Mode Visibility Design

Date: 2026-06-22

## Summary

`pi-claude-permissions` already tracks an active permission mode and writes it to Pi's standard status area with `ctx.ui.setStatus("permissions", ...)`. In this user's setup, `pi-powerbar` replaces the built-in footer, so the standard status entry is hidden. The extension should expose the current permission mode as a `pi-powerbar` segment while keeping the existing Pi status output as a fallback for users without `pi-powerbar`.

The extension will not mutate the user's `pi-powerbar` settings. It will register and update a segment named `permissions`; the user can choose whether and where to show it through `/extension-settings`.

## Goals

- Make the active permission mode visible in a `pi-powerbar` setup.
- Keep behavior compatible with plain Pi sessions that do not use `pi-powerbar`.
- Avoid taking a runtime dependency on `@juanibiapina/pi-powerbar`.
- Avoid automatically editing `~/.pi/agent/settings-extensions.json` or any other user configuration.
- Preserve the existing short Claude-like mode labels.

## Non-goals

- Rebuilding or forking `pi-powerbar`.
- Creating a separate always-visible widget outside `pi-powerbar`.
- Changing permission enforcement behavior.
- Changing mode names, mode cycling, or `/permissions` selection behavior.
- Automatically enabling the segment in the user's powerbar left/right lists.

## Current State

The extension defines built-in modes with `status` and `label` metadata:

| Mode | Current display metadata |
| --- | --- |
| `default` | `⏵ Default` |
| `plan` | `⏸ Plan` |
| `acceptEdits` | `⏵⏵ Accept Edits` |
| `bypassPermissions` | `⏵⏵⏵⏵ Bypass Permissions` |

It updates Pi's built-in status with:

```ts
ctx.ui.setStatus("permissions", `${meta.status} ${meta.label}`);
```

`pi-powerbar` supports extension-produced segments through event bus events:

```ts
pi.events.emit("powerbar:register-segment", {
  id: "permissions",
  label: "Permissions",
});

pi.events.emit("powerbar:update", {
  id: "permissions",
  text: "Plan",
  icon: "⏸",
  color: "warning",
});
```

Registered segments appear in `/extension-settings`, but are not displayed until selected in the powerbar left or right segment list.

## User Experience

When `pi-powerbar` is installed and the user enables the `Permissions` segment, the active mode appears as a compact Claude-like powerbar segment:

| Mode | Segment |
| --- | --- |
| `default` | `⏵ Default` |
| `plan` | `⏸ Plan` |
| `acceptEdits` | `⏵⏵ Accept Edits` |
| `bypassPermissions` | `⏵⏵⏵⏵ Bypass` |
| custom mode | `<status> <label>` |

The segment should be registered under:

- id: `permissions`
- label: `Permissions`

The user enables it manually:

```text
/extension-settings → powerbar → Left segments / Right segments → Permissions
```

The extension continues to update Pi's built-in status as a fallback. If `pi-powerbar` is absent, disabled, or configured not to show `permissions`, nothing breaks.

## Display Mapping

Add a helper that converts mode metadata into a display model used by both output channels:

```ts
interface ModeDisplay {
  icon: string;
  text: string;
  color: string;
  statusText: string;
}
```

The display model is derived from `ModeDefinition`:

- `icon`: `mode.status`
- `text`: shortened label when useful, otherwise `mode.label`
- `statusText`: `${icon} ${text}`
- `color`: selected by mode id

Recommended colors:

| Mode | Color |
| --- | --- |
| `default` | `muted` |
| `plan` | `warning` |
| `acceptEdits` | `accent` |
| `bypassPermissions` | `warning` |
| custom mode | `muted` |

`bypassPermissions` uses `warning` rather than `error`; it should be noticeable without looking like a runtime failure.

## Architecture

Keep powerbar integration isolated from permission enforcement.

Add small helpers in `extensions/index.ts`:

```ts
function registerPowerbarSegment(pi: ExtensionAPI): void;
function updatePowerbarSegment(pi: ExtensionAPI, display: ModeDisplay): void;
function clearPowerbarSegment(pi: ExtensionAPI): void;
function updatePiStatus(ctx: UiContext, display: ModeDisplay): void;
function updateModeDisplay(ctx: UiContext): void;
```

`updateModeDisplay` becomes the single path for display updates:

1. Resolve current mode metadata with `getModeMeta(mode, modes)`.
2. Convert it to `ModeDisplay`.
3. Emit `powerbar:update`.
4. Update `ctx.ui.setStatus` fallback.

This replaces the current narrow `updateStatus` responsibility without changing enforcement logic.

## Lifecycle

### Extension load

Register the powerbar segment early:

```ts
registerPowerbarSegment(pi);
```

This lets `pi-powerbar` add the segment to its settings catalog when it is already loaded.

### Session start

After mode resolution and plan-mode tool scoping, call:

```ts
registerPowerbarSegment(pi);
updateModeDisplay(ctx);
```

Registering again on `session_start` is harmless and improves resilience during reloads or unusual load orders.

### Mode changes

When mode changes through `Shift+Tab` or `/permissions`, keep the existing side effects and replace the final status update with:

```ts
updateModeDisplay(ctx);
```

### Session shutdown

Clear the segment to prevent stale display during shutdown or reload:

```ts
clearPowerbarSegment(pi);
```

`pi-powerbar` treats `text: undefined` with no bar as deletion.

## Configuration Interaction

### `hideDefaultMode`

Apply `hideDefaultMode` consistently to both channels. When it is true and the active mode equals the configured default mode:

- clear the Pi status entry;
- clear the powerbar segment.

This preserves the current intent of hiding normal/default state.

### Powerbar settings

The extension does not edit `settings-extensions.json`. Users opt into display through `/extension-settings`.

A typical manual configuration could become:

```json
{
  "powerbar": {
    "left": "permissions,git-branch,context-usage,sub-hourly,sub-weekly",
    "right": "provider,model"
  }
}
```

## Edge Cases

### `pi-powerbar` not installed

`pi.events.emit("powerbar:*", ...)` has no listener and does nothing. The built-in Pi status fallback remains.

### Segment registered but not selected

The segment is available in `/extension-settings` but invisible. This is expected because the user asked not to auto-add it.

### Custom modes

Custom modes use their configured `status` and `label`. Unknown mode ids use `muted` color. Permission policy behavior is unchanged.

### Reloads

Repeated segment registration is safe because `pi-powerbar` stores registrations by id. Re-emitting updates on `session_start` restores display after reload.

## Testing Plan

Automated/local checks:

```bash
npm run typecheck
npm run pack:dry
PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'
```

Manual TUI checks:

1. Run `/reload` after installing the local extension.
2. Open `/extension-settings`.
3. Add `Permissions` to `powerbar → Left segments` or `Right segments`.
4. Confirm startup mode appears in the powerbar.
5. Use `Shift+Tab` and confirm the segment updates for every mode.
6. Use `/permissions` and confirm manual selection updates the segment.
7. Enter `plan` and confirm `⏸ Plan` is shown.
8. Configure `hideDefaultMode: true` and confirm the segment/status clears when active mode equals the default.

## Implementation Boundaries

The implementation should touch only files required for this behavior, expected to be:

- `extensions/index.ts`
- `README.md` if documenting the powerbar segment and setup step is useful

No permission enforcement logic should be changed unless necessary to wire display updates.
