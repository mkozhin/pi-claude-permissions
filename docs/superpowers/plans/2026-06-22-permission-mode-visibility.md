# Permission Mode Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the active permission mode as a `pi-powerbar` segment while keeping the existing Pi status output as fallback.

**Architecture:** Keep display integration separate from permission enforcement. Add small display helpers in `extensions/index.ts` that convert `ModeDefinition` into a shared `ModeDisplay`, emit `powerbar:*` events, and update Pi's standard status. Wire those helpers into existing lifecycle points (`session_start`, mode changes, `session_shutdown`) without changing tool-blocking logic.

**Tech Stack:** Pi extension TypeScript loaded by jiti, Pi extension event bus, optional `pi-powerbar` event API, Node.js, npm, TypeScript typechecking.

## Global Constraints

- Do not add a runtime dependency or import for `@juanibiapina/pi-powerbar`.
- Do not edit `~/.pi/agent/settings-extensions.json` or auto-enable the segment in powerbar settings.
- Powerbar segment id must be `permissions` and label must be `Permissions`.
- Keep the existing standard Pi status fallback using `ctx.ui.setStatus("permissions", ...)`.
- Apply `hideDefaultMode` consistently to both Pi status and powerbar segment.
- Preserve existing permission enforcement behavior, mode names, `/permissions`, and `Shift+Tab` cycling.
- Use short Claude-like display text: `⏵ Default`, `⏸ Plan`, `⏵⏵ Accept Edits`, `⏵⏵⏵⏵ Bypass`.

---

## File Structure

- Modify `extensions/index.ts`
  - Responsibility: runtime mode tracking, permission enforcement, and display updates. Add display-only helpers and lifecycle wiring.
- Modify `README.md`
  - Responsibility: user-facing setup. Document the optional `pi-powerbar` segment and the manual `/extension-settings` enablement step.

No new runtime files are required. No package dependency changes are required.

---

### Task 1: Add powerbar segment display helpers and lifecycle wiring

**Files:**
- Modify: `extensions/index.ts`

**Interfaces:**
- Consumes: existing `ModeDefinition`, `PermissionMode`, `mode`, `defaultMode`, `hideDefaultMode`, `getModeMeta()`, existing `updateStatus(ctx)` call sites.
- Produces: `ModeDisplay`, `registerPowerbarSegment()`, `updatePowerbarSegment()`, `clearPowerbarSegment()`, and `updateModeDisplay(ctx)` behavior. Later README docs rely on segment id `permissions` and label `Permissions`.

- [ ] **Step 1: Inspect current display update code**

Run:

```bash
grep -n "const updateStatus\|updateStatus(ctx)\|session_shutdown\|ctx.ui.setStatus" extensions/index.ts
```

Expected: output shows `const updateStatus = (ctx: UiContext) => { ... }`, `ctx.ui.setStatus("permissions", ...)`, `updateStatus(ctx)` in `applyMode`, and `updateStatus(ctx)` in `session_start`. There is no existing `session_shutdown` handler for permissions display.

- [ ] **Step 2: Add display model types and constants**

In `extensions/index.ts`, immediately after the existing `interface ModeDefinition` block, add:

```ts
interface ModeDisplay {
  icon: string;
  text: string;
  color: string;
  statusText: string;
}
```

Immediately after `const PLAN_BLOCK_REASON = ...`, add:

```ts
const POWERBAR_SEGMENT_ID = "permissions";
const POWERBAR_SEGMENT_LABEL = "Permissions";
```

Expected: these additions are type-only/display-only and do not alter permission policy.

- [ ] **Step 3: Register the powerbar segment during extension load**

In `permissionExtension`, after the two `pi.registerFlag(...)` calls and before `const config = await loadConfig();`, add:

```ts
  registerPowerbarSegment(pi);
```

Expected surrounding structure:

```ts
  pi.registerFlag("dangerously-skip-permissions", {
    description: "Bypass all permission checks except catastrophic/protected checks",
    type: "boolean",
    default: false,
  });

  registerPowerbarSegment(pi);

  const config = await loadConfig();
```

- [ ] **Step 4: Replace `updateStatus` with shared display update helpers in the factory closure**

Replace the existing `const updateStatus = (ctx: UiContext) => { ... };` closure with:

```ts
  const clearModeDisplay = (ctx: UiContext) => {
    clearPowerbarSegment(pi);
    ctx.ui.setStatus("permissions", undefined);
  };

  const updateModeDisplay = (ctx: UiContext) => {
    if (hideDefaultMode && mode === defaultMode) {
      clearModeDisplay(ctx);
      return;
    }

    const display = getModeDisplay(getModeMeta(mode, modes));
    updatePowerbarSegment(pi, display);
    updatePiStatus(ctx, display);
  };
```

Expected: `hideDefaultMode` now clears both powerbar and Pi status. Normal mode display updates both channels.

- [ ] **Step 5: Update existing mode display call sites**

In `applyMode`, replace:

```ts
    updateStatus(ctx);
```

with:

```ts
    updateModeDisplay(ctx);
```

In the `session_start` handler, replace:

```ts
    updateStatus(ctx);
```

with:

```ts
    registerPowerbarSegment(pi);
    updateModeDisplay(ctx);
```

Expected: mode changes and startup both publish to powerbar and Pi status.

- [ ] **Step 6: Clear the powerbar segment on session shutdown**

After the `session_start` handler and before `pi.registerShortcut("shift+tab", ...)`, add:

```ts
  pi.on("session_shutdown", async () => {
    clearPowerbarSegment(pi);
  });
```

Expected: reloads and shutdowns do not leave stale `permissions` segment data in `pi-powerbar`.

- [ ] **Step 7: Add top-level display helper functions**

After `getModeMeta()` and before `enforcePlanMode(...)`, add these top-level helpers:

```ts
function getModeDisplay(mode: ModeDefinition): ModeDisplay {
  const text = getModeDisplayText(mode);
  return {
    icon: mode.status,
    text,
    color: getModeDisplayColor(mode.id),
    statusText: `${mode.status} ${text}`,
  };
}

function getModeDisplayText(mode: ModeDefinition): string {
  if (mode.id === "bypassPermissions") return "Bypass";
  return mode.label;
}

function getModeDisplayColor(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "warning";
    case "acceptEdits":
      return "accent";
    case "bypassPermissions":
      return "warning";
    case "default":
    default:
      return "muted";
  }
}

function registerPowerbarSegment(pi: ExtensionAPI): void {
  pi.events.emit("powerbar:register-segment", {
    id: POWERBAR_SEGMENT_ID,
    label: POWERBAR_SEGMENT_LABEL,
  });
}

function updatePowerbarSegment(pi: ExtensionAPI, display: ModeDisplay): void {
  pi.events.emit("powerbar:update", {
    id: POWERBAR_SEGMENT_ID,
    text: display.text,
    icon: display.icon,
    color: display.color,
  });
}

function clearPowerbarSegment(pi: ExtensionAPI): void {
  pi.events.emit("powerbar:update", {
    id: POWERBAR_SEGMENT_ID,
    text: undefined,
  });
}

function updatePiStatus(ctx: UiContext, display: ModeDisplay): void {
  ctx.ui.setStatus("permissions", display.statusText);
}
```

Expected: no imports are added. `pi.events.emit(...)` is safe when `pi-powerbar` is absent.

- [ ] **Step 8: Verify no old `updateStatus` references remain**

Run:

```bash
grep -n "updateStatus" extensions/index.ts || true
```

Expected: no output.

Run:

```bash
grep -n "powerbar:\|POWERBAR_SEGMENT\|ModeDisplay\|updateModeDisplay\|session_shutdown" extensions/index.ts
```

Expected: output shows the new constants, interface, registration/update helpers, factory-load registration, `session_start` registration/update, `session_shutdown` cleanup, and `updateModeDisplay` call sites.

- [ ] **Step 9: Run typecheck after code changes**

Run:

```bash
npm run typecheck
```

Expected output includes:

```text
> @mkozhin/pi-claude-permissions@0.1.0 typecheck
> tsc --noEmit
```

Expected exit code: `0`.

---

### Task 2: Document powerbar setup and verify package behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: powerbar segment id `permissions`, label `Permissions`, manual `/extension-settings` enablement behavior from Task 1.
- Produces: README instructions for users who run `pi-powerbar` and want to display the active permission mode.

- [ ] **Step 1: Update feature summary in README**

In `README.md`, replace this bullet:

```md
- Shows current mode in the pi footer/status line.
```

with:

```md
- Shows current mode in the Pi status line and can publish a `pi-powerbar` segment.
```

Expected: summary mentions both fallback status and powerbar support.

- [ ] **Step 2: Add a Powerbar visibility section**

In `README.md`, after the paragraph that explains `planModeAllowedMcpServers`, add:

```md
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
```

Expected: README clearly states manual enablement and does not claim the extension mutates powerbar settings.

- [ ] **Step 3: Verify README formatting**

Run:

```bash
grep -n "Powerbar visibility\|permissions\|Permissions\|⏵⏵⏵⏵ Bypass" README.md
```

Expected: output shows the new section title, segment id, segment label, and bypass display row.

- [ ] **Step 4: Verify source/doc diff scope**

Run:

```bash
git diff -- extensions/index.ts README.md
```

Expected: diff only adds display helpers/lifecycle wiring in `extensions/index.ts` and powerbar documentation in `README.md`. No permission enforcement branch changes in `tool_call`, `enforcePlanMode`, `enforceCustomMode`, or `promptApproval`.

- [ ] **Step 5: Run package dry-run**

Run:

```bash
npm run pack:dry
```

Expected output includes:

```text
npm notice 📦  @mkozhin/pi-claude-permissions@0.1.0
```

Expected exit code: `0`.

- [ ] **Step 6: Smoke-test extension loading**

Run:

```bash
PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'
```

Expected output:

```text
No models matching "__no_such_model__"
```

Expected exit code: `0`.

- [ ] **Step 7: Commit the powerbar visibility integration**

Run:

```bash
git add extensions/index.ts README.md
git commit -m "feat: publish permission mode to powerbar"
```

Expected: commit succeeds and includes only `extensions/index.ts` and `README.md` changes for the powerbar visibility integration.

---

## Self-Review

**Spec coverage:**

- Powerbar segment registration: Task 1 Steps 3 and 7.
- Powerbar segment update on startup and mode changes: Task 1 Steps 4 and 5.
- Standard Pi status fallback: Task 1 Steps 4 and 7 via `updatePiStatus`.
- `hideDefaultMode` clears both channels: Task 1 Step 4.
- No auto-edit of powerbar settings: Task 2 Step 2 documentation and no code step that writes settings.
- No runtime dependency/import: Task 1 Step 7 explicitly uses only `pi.events.emit`.
- Shutdown cleanup: Task 1 Step 6.
- Short Claude-like labels and colors: Task 1 Step 7 and Task 2 Step 2.
- Verification: Task 1 Step 9 and Task 2 Steps 3-6.

**Completeness scan:** The plan contains no unresolved blanks and no unspecified implementation steps.

**Type consistency:** The plan uses existing names exactly as in the codebase (`ExtensionAPI`, `UiContext`, `ModeDefinition`, `PermissionMode`, `getModeMeta`, `hideDefaultMode`, `defaultMode`) and introduces consistently named display helpers (`ModeDisplay`, `getModeDisplay`, `updateModeDisplay`, `registerPowerbarSegment`, `updatePowerbarSegment`, `clearPowerbarSegment`, `updatePiStatus`).
