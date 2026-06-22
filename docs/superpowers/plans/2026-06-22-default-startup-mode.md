# Default Startup Permission Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this fork start in `default` permission mode unless the user explicitly configures or requests another mode.

**Architecture:** The startup default is controlled by a single fallback constant in `extensions/index.ts`; existing config and CLI override paths already flow through that fallback. The implementation changes the constant and updates README text so package behavior and documentation agree, without touching mode enforcement logic.

**Tech Stack:** Pi extension TypeScript loaded by jiti, Node.js, npm, TypeScript typechecking.

## Global Constraints

- Built-in package default must be `default`, not `bypassPermissions`.
- Existing `piClaudePermissions.defaultMode` settings must continue to override the built-in default.
- Existing legacy `.pi/extensions/permissions.json` and `~/.pi/agent/extensions/permissions.json` mode/defaultMode config must continue to work.
- Existing CLI `--permission-mode <mode>` must continue to override startup mode.
- Existing CLI `--dangerously-skip-permissions` must continue to force `bypassPermissions`.
- No permission enforcement semantics should change.
- Do not edit the user's local `~/.pi/agent/settings.json` to force the behavior.

---

## File Structure

- Modify `extensions/index.ts`
  - Responsibility: extension runtime behavior. Change only package-level default metadata/comment and the `DEFAULT_MODE` fallback constant.
- Modify `README.md`
  - Responsibility: user-facing package behavior and configuration examples. Update default startup mode documentation to match this fork.

No new source files or tests are required for this narrow behavior change.

---

### Task 1: Change the fork's built-in startup mode to `default`

**Files:**
- Modify: `extensions/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `DEFAULT_MODE: PermissionMode`, `normalizeMode(config.defaultMode, DEFAULT_MODE, modes)`, existing CLI flag handling in `session_start`.
- Produces: package-level default startup mode of `default`; README instructions that document the new default and preserve explicit opt-in to `bypassPermissions`.

- [x] **Step 1: Inspect the current default mode constant and README references**

Run:

```bash
grep -n "DEFAULT_MODE\|Default startup mode\|This is the default mode\|defaultMode\|bypassPermissions" extensions/index.ts README.md
```

Expected: output includes `const DEFAULT_MODE: PermissionMode = "bypassPermissions";`, a header comment saying bypass is the default startup mode, README text saying `bypassPermissions` is the default mode, and a config example with `"defaultMode": "bypassPermissions"`.

- [x] **Step 2: Update `extensions/index.ts` default metadata**

Edit `extensions/index.ts` so the file header no longer says bypass is the startup default. Replace this comment bullet:

```ts
 * - Default startup mode is bypassPermissions.
```

with:

```ts
 * - Default startup mode is confirmation mode (`default`) in this fork.
```

Then replace the fallback constant:

```ts
const DEFAULT_MODE: PermissionMode = "bypassPermissions";
```

with:

```ts
const DEFAULT_MODE: PermissionMode = "default";
```

Do not change `loadConfig()`, `normalizeMode()`, `session_start`, `enforceAlwaysOnSafety()`, or any mode enforcement branch.

- [x] **Step 3: Update README mode descriptions**

Edit `README.md` so `default` is documented as the startup default. In the `### default` section, keep the existing bullets and add this bullet after “Confirmation mode.” or after the existing bullet list:

```md
- This is the startup default for this fork.
```

In the `### bypassPermissions` section, remove this bullet:

```md
- This is the default mode.
```

Keep the existing explanation that `bypassPermissions` allows normal operations without confirmation and still blocks catastrophic/protected operations.

- [x] **Step 4: Update README configuration example**

In `README.md`, change the sample configuration from:

```json
{
  "piClaudePermissions": {
    "defaultMode": "bypassPermissions",
    "allowCatastrophic": false,
    "shiftTabOptions": ["default", "plan", "acceptEdits", "bypassPermissions"],
    "hideDefaultMode": false,
    "planModeAllowedMcpServers": []
  }
}
```

to:

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

Then replace the explanatory sentence for `defaultMode` with:

```md
`defaultMode` controls the startup mode and defaults to `default` in this fork. Valid built-in values are `default`, `plan`, `acceptEdits`, and `bypassPermissions`. Set it explicitly if you want a different startup mode.
```

- [x] **Step 5: Verify the intended code diff is narrow**

Run:

```bash
git diff -- extensions/index.ts README.md
```

Expected: `extensions/index.ts` diff changes only the header comment bullet and `DEFAULT_MODE`; `README.md` diff changes only default-mode documentation/config text. No mode enforcement branches change.

- [x] **Step 6: Run typecheck**

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

- [x] **Step 7: Run package dry-run**

Run:

```bash
npm run pack:dry
```

Expected output includes:

```text
npm notice 📦  @mkozhin/pi-claude-permissions@0.1.0
```

Expected exit code: `0`.

- [x] **Step 8: Smoke-test extension loading**

Run:

```bash
PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'
```

Expected output:

```text
No models matching "__no_such_model__"
```

Expected exit code: `0`.

- [x] **Step 9: Commit the default startup mode change**

Run:

```bash
git add extensions/index.ts README.md
git commit -m "feat: default to confirmation mode"
```

Expected: commit succeeds and includes only the source/doc changes for this task. If unrelated pre-existing changes are present in the working tree, do not stage them.

## Execution Results

Completed on 2026-06-22.

- Pre-existing fork setup changes were committed separately as `e8b7b20 chore: initialize personal fork` so this implementation stayed narrow.
- Implementation committed as `68e55d0 feat: default to confirmation mode`.
- `npm run typecheck` passed with exit code 0.
- `npm run pack:dry` passed with exit code 0.
- `PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'` passed with output `No models matching "__no_such_model__"`.
- Working tree was clean after the implementation commit.

---

## Self-Review

**Spec coverage:**

- Package-level default changes from `bypassPermissions` to `default`: Task 1 Step 2.
- Config override compatibility preserved by not changing config loading or normalization: Task 1 Step 2.
- CLI override compatibility preserved by not changing `session_start` flag handling: Task 1 Step 2.
- Dangerous skip behavior preserved by not changing `--dangerously-skip-permissions` handling: Task 1 Step 2.
- README updated: Task 1 Steps 3 and 4.
- Tests/checks: Task 1 Steps 6, 7, and 8.

**Completeness scan:** The plan contains no unresolved blanks and no unspecified implementation steps.

**Type consistency:** The plan uses existing names exactly as in the codebase: `DEFAULT_MODE`, `PermissionMode`, `defaultMode`, `bypassPermissions`, `acceptEdits`, `--permission-mode`, and `--dangerously-skip-permissions`.
