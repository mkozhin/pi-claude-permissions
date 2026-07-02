# Numbered Quick-Pick Choices in Approval Confirmation Dialog

## Overview
- Replace the approval confirmation dialog in `promptApproval()` (extensions/index.ts) — currently rendered via the host's opaque `ctx.ui.select()` widget — with a custom dialog built on `ctx.ui.custom()` that shows numbered options (`1.`, `2.`, `3.`) and resolves the choice **instantly** when the user presses the corresponding digit key, in addition to the existing arrow-keys+Enter flow.
- Problem it solves: today's `ctx.ui.select()` dialog is host-managed and only supports Up/Down/PageUp/PageDown/Enter/Escape — there is no way, via that API, to jump directly to an option by pressing its number. Users must always navigate with arrows even when they know exactly which option they want.
- Integrates with the existing system by keeping the exact same return contract (`string | undefined` matching one of the `options` array entries, or `undefined` for cancel/Deny) so the rest of `promptApproval()` — including session-allow bookkeeping and the safety-block return — is unchanged.

## Context (from discovery)
- files/components involved:
  - `extensions/index.ts` — `promptApproval()` (~line 2663) builds `icon`/`description` via `describeApprovalRequest()`, calls `ctx.ui.select(title, options)`, then branches on the returned string. `UiContext` type (~line 18) currently types `ui: any`.
  - `tests/plan-ended-context.test.cjs` — `createHarness()` (~line 65) mocks `ctx.ui` with `select()`, driven by a `selectResponses` queue, recording `lastSelectPrompt`/`lastSelectOptions`/`selectCallCount`. ~35 existing assertions across the file depend on these three accessors for approval-flow tests.
  - `package.json` — declares `@earendil-works/pi-coding-agent` as `peerDependencies`/`devDependencies` (`^0.79.9`), but **not** `@earendil-works/pi-tui`.
  - `README.md`, `CLAUDE.md` — user-facing/maintainer docs describing permission-mode behavior.
- related patterns found:
  - `ctx.ui.custom<T>(factory, options?)` is a first-class, documented `ExtensionUIContext` method ("Show a custom component with keyboard focus") returning `Promise<T>`. The factory receives `(tui, theme, keybindings, done)` and returns a `Component` (`{ render(width): string[], handleInput?(data): void }`).
  - The host's own bundled example extension `questionnaire.ts` (in the installed `@earendil-works/pi-coding-agent` package's `examples/extensions/`) demonstrates this exact pattern: `ctx.ui.custom()` with numbered option rendering (`${i + 1}. ${opt.label}`), `theme.fg(...)` styling, and imports `Key`, `matchesKey` from `@earendil-works/pi-tui`. It does **not** wire digit-key selection — that's the gap this plan closes.
  - `matchesKey(data, keyId)` from `@earendil-works/pi-tui` treats single digit characters ("1"–"9") as valid `KeyId`s, so `matchesKey(data, "1")` works without custom parsing.
  - Confirmed exact byte sequences used by the host's own `keys.js`: `escape` matches `"\x1b"`, `enter` matches `"\r"` (also `"\n"` outside Kitty protocol, and `"\x1bOM"`), `up` matches `"\x1b[A"`/`"\x1bOA"`, `down` matches `"\x1b[B"`/`"\x1bOB"`.
- dependencies identified:
  - **Runtime**: confirmed by reading `dist/core/extensions/loader.js` in the installed `@earendil-works/pi-coding-agent` package — the extension loader's `jiti` alias map (`getAliases()`) explicitly maps `"@earendil-works/pi-tui"` to the host's own bundled copy, regardless of what's in the extension's own `node_modules`. So `import { Key, matchesKey } from "@earendil-works/pi-tui"` resolves correctly at real runtime for end users with no extra install step on their side.
  - **Local dev tooling**: `tsc --noEmit` and `npm run test` (which transpiles `extensions/index.ts` via `ts.transpileModule` and then runs real Node `require()` on any value imports) do **not** get the host's alias magic — they need `@earendil-works/pi-tui` to be a real, resolvable package in this repo's own `node_modules`. It is currently only nested three levels deep under `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`, unresolvable as a bare specifier from this project.
  - **Version correction (caught in plan review):** this repo's own `node_modules/@earendil-works/pi-coding-agent` — the copy that actually matters, resolved from this repo's `devDependencies: "^0.79.9"` — is version `0.79.10`, and it declares `"@earendil-works/pi-tui": "^0.79.10"` (its own bundled nested copy is also `0.79.10`). An earlier investigation pass mistakenly cited a globally-installed Homebrew `pi-coding-agent@0.80.3` CLI instead of this repo's local copy — that global CLI is irrelevant to this repo's dev tooling. The devDependency to add must be pinned to `^0.79.10`, matching what the host actually bundles here, so `tsc`/`npm test` type-check and execute against the **same** `Key`/`matchesKey` semantics the real runtime alias provides — a version mismatch here would silently undercut the entire "reuse the host's exact key-matching semantics" rationale.
  - Decision (open question resolved by best judgment after no user response — recommended path chosen): add `@earendil-works/pi-tui` as an explicit `devDependency` and import `Key`/`matchesKey` from it, reusing the host's exact key-matching semantics (Kitty protocol handling, legacy sequences, etc.) rather than hand-rolling a byte matcher that could silently diverge from real terminal behavior.
- key risks / unknowns:
  - Rendering without `overlay: true` should visually match the previous `ctx.ui.select()` inline placement, but this can only be fully confirmed in a live TUI session (see Post-Completion).
  - The mock test harness's `ctx.ui.custom()` implementation reconstructs `prompt`/`options` by parsing the component's own `render()` output text — this couples the mock to the render-line format (`"N. label"`) produced by the new helper. Must be documented inline so future formatting changes update both sides together. This mock also only survives because each option is rendered as a single line with no description sub-line — if a future change adds per-option description lines (as the `questionnaire.ts` example does), the parsing regex would silently drop them; keep options single-line or update the parser in lockstep.
  - **`describeApprovalRequest()` returns multi-line descriptions** for dangerous/catastrophic bash commands (`extensions/index.ts:2707-2709`, e.g. `` `bash: ${command}\n   ⚠️  DANGEROUS: ${danger.description}` ``) — these are real, reachable cases (dangerous commands always reach the dialog; catastrophic ones reach it when `allowCatastrophic` is configured, already covered by existing tests). The `render()` implementation must split the title on `\n` into separate line entries rather than pushing one raw multi-line string into the `lines` array, or the numbered dialog will visually break on precisely the highest-stakes approvals. The `custom()` mock (Task 3) reconstructs `lastSelectPrompt` from only the *first* rendered line, so it will not surface a broken split on its own — this needs the explicit `render()`-output unit check in Task 5 plus a manual verification step.

## Development Approach
- **testing approach**: Regular — implement focused logic first, then add/update harness tests for the new behavior (consistent with the prior `20260623-default-read-allowlist` plan in this repo).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task**.
- **CRITICAL: update this plan file when scope changes during implementation**.
- Run tests after each change.
- Maintain backward compatibility: the mode-select dialog (`ctx.ui.select("Select permission mode", ...)`, ~line 337, driven by Shift+Tab/`/permissions`) and every other `ctx.ui.select`/`ctx.ui.confirm` call site are explicitly out of scope and must not change behavior.

## Testing Strategy
- Unit/harness tests required for every behavior-changing task, using the existing `tests/plan-ended-context.test.cjs` CommonJS harness (no new test runner/framework).
- Cover success cases:
  - Pressing digit `1`/`2`/`3` resolves the corresponding option immediately (no Enter needed).
  - Arrow Up/Down still moves the highlighted selection with wrap-around, and Enter confirms the highlighted option (non-digit path still works).
  - All ~35 existing approval-flow assertions (`selectCallCount`, `lastSelectPrompt`, `lastSelectOptions`) continue to pass unchanged, now exercised through the digit-key path via the extended mock.
  - Rendered output actually contains the numbered lines (`"1. "`, `"2. "`, `"3. "` with the correct option text) — a regression guard for the core visible feature.
- Cover error/edge cases:
  - A digit outside the option range (e.g. `"9"` when there are only 3 options) is ignored — dialog stays open, `done()` is not called.
  - Escape resolves `undefined`, which — unchanged from today — causes `promptApproval()` to return `{ block: true, reason: ... }` (Deny), verified with an explicit assertion.
  - Session-allow / protected-path / catastrophic-command precedence tests elsewhere in the file are unaffected since `promptApproval()`'s post-dialog logic is untouched.
- No e2e/browser tests apply; this is a terminal UI change. Manual TUI verification is required post-completion and cannot be scripted (see Post-Completion).

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Keep plan in sync with actual work.

## Solution Overview
- Add a new helper `promptApprovalChoice(ctx, title, options)` next to `promptApproval()` that wraps `ctx.ui.custom<string | undefined>(...)`, replacing the single `ctx.ui.select(...)` call inside `promptApproval()`. No other logic in `promptApproval()` changes.
- The custom component renders the title, a blank line, numbered options with a `"→ "` prefix on the highlighted one, and a footer hint line, mirroring the host's own `SelectList` visual conventions closely enough to feel native.
- `handleInput()` checks digit keys first (instant resolve), then falls back to Up/Down (move selection) and Enter (resolve highlighted) and Escape (resolve `undefined`), matching `SelectList`'s existing key set plus the new digit shortcut.
- Add `@earendil-works/pi-tui` as an explicit `devDependency` so `Key`/`matchesKey` resolve during local `tsc`/`npm test`; real end-user runtime resolution already works via the host's own alias map (verified, no action needed there).

## Technical Details
- New imports in `extensions/index.ts`:
  ```ts
  import { Key, matchesKey } from "@earendil-works/pi-tui";
  ```
- New helper (approximate shape, adjust naming/formatting to match existing file conventions):
  ```ts
  async function promptApprovalChoice(ctx: UiContext, title: string, options: string[]): Promise<string | undefined> {
    return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
      let selectedIndex = 0;

      function handleInput(data: string) {
        for (let i = 0; i < options.length && i < 9; i++) {
          if (matchesKey(data, String(i + 1) as KeyId)) {
            done(options[i]);
            return;
          }
        }
        if (matchesKey(data, Key.up)) {
          selectedIndex = (selectedIndex - 1 + options.length) % options.length;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down)) {
          selectedIndex = (selectedIndex + 1) % options.length;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          done(options[selectedIndex]);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(undefined);
          return;
        }
      }

      function render(width: number): string[] {
        // title may contain embedded "\n" for dangerous/catastrophic bash descriptions
        // (see describeApprovalRequest, extensions/index.ts:2707-2709) — split, do not push raw.
        const lines = [...title.split("\n").map((line) => theme.fg("text", line)), ""];
        options.forEach((opt, i) => {
          const prefix = i === selectedIndex ? theme.fg("accent", "→ ") : "  ";
          lines.push(`${prefix}${i + 1}. ${opt}`);
        });
        lines.push("", theme.fg("dim", "↑↓ select • Enter confirm • 1-9 quick pick • Esc = Deny"));
        return lines;
      }

      return { render, handleInput };
    });
  }
  ```
  (`import type { KeyId } from "@earendil-works/pi-tui";` is needed alongside the value import for the `as KeyId` cast — confirmed `pi-tui`'s `keys.d.ts` exports a `Digit = "0"|...|"9"` union folded into `KeyId`, so `matchesKey(data, String(i + 1) as KeyId)` is correctly typed without an unjustified `as any`.)
- `promptApproval()` changes only its dialog call site:
  ```ts
  const choice = await promptApprovalChoice(ctx, `${icon} ${description}`, options);
  ```
  (replacing `const choice = await ctx.ui.select(`${icon} ${description}`, options);`) — all subsequent comparisons (`choice === options[0]`, etc.) stay as-is.
- `UiContext` type (~line 18): leave `ui: any` as-is — this is an existing, deliberate simplification already in the file (not introduced by this plan), so no typing change is required for `ctx.ui.custom` to be callable. Note this explicitly in Task 2 as a conscious choice, not an oversight.
- `package.json`: add `"@earendil-works/pi-tui": "^0.79.10"` (matching this repo's actual local `@earendil-works/pi-coding-agent` copy — `0.79.10`, which itself depends on `pi-tui@^0.79.10` — verified via `node_modules/@earendil-works/pi-coding-agent/package.json`; do **not** use `0.80.3`, that was an earlier mistaken reference to an unrelated globally-installed CLI) to `devDependencies`, then run `npm install` so it hoists into top-level `node_modules`.
- Mock harness addition in `tests/plan-ended-context.test.cjs` (~`createHarness()`), added alongside the existing `select()` mock, not replacing it (the mode-select dialog still needs `ui.select`):
  ```js
  custom(factory) {
    const fakeTui = { requestRender() {} };
    const fakeTheme = { fg: (_name, text) => text, bold: (text) => text };
    let doneValue;
    let resolved = false;
    const done = (value) => { doneValue = value; resolved = true; };
    const component = factory(fakeTui, fakeTheme, {}, done);

    const lines = component.render(80);
    const nonEmpty = lines.map((l) => l.replace(/^\s+|\s+$/g, "")).filter(Boolean);
    lastSelectPrompt = nonEmpty[0];
    lastSelectOptions = nonEmpty
      .map((l) => l.match(/^(?:→\s*)?\d+\.\s(.+)$/))
      .filter(Boolean)
      .map((m) => m[1]);
    selectCallCount += 1;

    const response = selectResponses.length > 0 ? selectResponses.shift() : undefined;
    const resolvedValue = typeof response === "function" ? response(lastSelectOptions, lastSelectPrompt) : response;

    if (resolvedValue === undefined) {
      component.handleInput("\x1b"); // Escape
    } else if (typeof resolvedValue === "number") {
      component.handleInput(String(resolvedValue + 1)); // digit key for index
    } else {
      const idx = lastSelectOptions.indexOf(resolvedValue);
      component.handleInput(idx >= 0 ? String(idx + 1) : "\x1b");
    }

    return resolved ? doneValue : undefined;
  },
  ```
  This is illustrative — exact regex/whitespace handling must be verified against the real render output produced by Task 2's helper (in particular the `"→ "` prefix uses a multi-byte arrow character; confirm the regex handles it, and that `fakeTheme.fg`/`bold` signatures match whatever the real `theme` object shape actually requires — check the host's `Theme` type used by `questionnaire.ts` for the accurate method signatures before implementing).

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, docs updates achievable in this repo.
- **Post-Completion** (no checkboxes): manual TUI verification, external actions.

## Validation Commands
- focused tests: `npm run test`
- full tests: `npm run test`
- lint/typecheck/build: `npm run typecheck`
- package dry-run: `npm run pack:dry`
- whitespace check: `git diff --check`
- optional extension load smoke test: `PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'`

## Implementation Steps

### Task 1: Add `@earendil-works/pi-tui` devDependency and confirm resolution

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (if present) or equivalent lockfile

- [x] Run `npm install --save-dev @earendil-works/pi-tui@^0.79.10` (matches this repo's actual local `@earendil-works/pi-coding-agent@0.79.10` and its own `pi-tui@^0.79.10` dependency — do not use `0.80.3`, that version belongs to an unrelated globally-installed CLI, not this repo's dev tooling).
- [x] Verify `node -e "console.log(require.resolve('@earendil-works/pi-tui'))"` succeeds from the repo root.
- [x] Verify `node -e "const {Key, matchesKey} = require('@earendil-works/pi-tui'); console.log(typeof Key, typeof matchesKey)"` prints `object function`.
- [x] Confirm `npm run typecheck` still passes with the new dependency present (no code changes yet, just confirming the install didn't break anything).
- [x] Run tests: `npm run test` — must pass before next task (no behavior change yet).

### Task 2: Implement `promptApprovalChoice()` custom numbered-choice dialog

**Files:**
- Modify: `extensions/index.ts`

- [x] Add `import { Key, matchesKey } from "@earendil-works/pi-tui";` near the top of `extensions/index.ts`.
- [x] Implement `promptApprovalChoice(ctx: UiContext, title: string, options: string[]): Promise<string | undefined>` near `promptApproval()` (~line 2663), per the Technical Details sketch: digit-key instant resolve (checked first), Up/Down move-with-wrap, Enter resolves highlighted, Escape resolves `undefined`.
- [x] Type the digit `matchesKey` call as `matchesKey(data, String(i + 1) as KeyId)` with `import type { KeyId } from "@earendil-works/pi-tui";` — confirmed correct against `pi-tui`'s `Digit = "0"|...|"9"` union folded into `KeyId` (see Technical Details); no `as any` needed.
- [x] Render output: title line, blank line, `"N. option"` lines with `"→ "` prefix on the selected index, trailing footer hint line — confirm against the real `theme` object's actual method signatures (check `pi-coding-agent`'s `Theme` type, e.g. via the `questionnaire.ts` example's usage of `theme.fg(...)`, before finalizing).
- [x] Do **not** wire this helper into `promptApproval()` yet (that's Task 4) — this task only adds the standalone helper.
- [x] Write a small standalone unit test (new test function in `tests/plan-ended-context.test.cjs`, or a separate lightweight test file if cleaner) that imports/exercises `promptApprovalChoice` in isolation if the file's export surface allows it; if the function is not separately exported/testable in isolation without the full harness, note this and defer direct coverage to Task 5 (exercised through `promptApproval()` end-to-end instead) — do not skip test writing, document the dependency per the plan's partial-implementation exception rule. Confirmed `extensions/index.ts` only has a `default` export (`permissionExtension`) and `loadExtension()` in the test harness only surfaces `module.exports.default`, so isolated unit testing of `promptApprovalChoice` is not possible without changing the export surface; documented this inline above the helper and deferred coverage to Task 5, per the plan's partial-implementation exception.
- [x] Run tests: `npm run test` and `npm run typecheck` — must pass before next task.

### Task 3: Extend test harness mock with `ctx.ui.custom()`

**Files:**
- Modify: `tests/plan-ended-context.test.cjs`

- [x] Add `custom(factory)` to the mock `ctx.ui` object in `createHarness()` (~line 95), alongside the existing `select()` (do not remove `select()` — the mode-select dialog still needs it). At this point `custom()` is added but not yet exercised by `promptApproval()` (that happens in Task 4) — this ordering keeps the test suite green throughout instead of having a deliberately-red window.
- [x] Implement the mock per the Technical Details sketch: invoke `factory(fakeTui, fakeTheme, fakeKb, done)`, render once to reconstruct `lastSelectPrompt`/`lastSelectOptions` (splitting/handling multi-line title output per Task 2's render format), reuse the existing `selectResponses` queue, and resolve via real `component.handleInput(...)` calls using the confirmed byte sequences (`"\x1b"` for escape/cancel, `String(index + 1)` for digit selection) rather than calling `done()` directly — so the new digit-key code path gets exercised by every existing approval-flow test once Task 4 wires it in.
- [x] Add an inline comment documenting that the render-line parsing regex is coupled to `promptApprovalChoice()`'s exact output format and must be kept in sync.
- [x] Confirm `fakeTheme`'s method shape (`fg`, `bold`, whatever `promptApprovalChoice()` actually calls) matches what Task 2's implementation needs — adjust the fake if Task 2 ended up using additional theme methods. Verified: Task 2's real `promptApprovalChoice()` only calls `theme.fg(name, text)`; `fakeTheme` provides `fg` (used) and `bold` (unused, kept for forward compatibility with the `questionnaire.ts`-style theme shape).
- [x] Write a small direct test exercising the new mock's `custom()` path in isolation (e.g. call `ctx.ui.custom(...)` with a minimal test factory) to confirm the mock itself behaves correctly before Task 4 wires real usage into it. Added `testUiCustomMockDrivesDigitSelectionAndTracksPromptOptions()` using a `makeChoiceFactory()` helper that mirrors the real `promptApprovalChoice()` render/handleInput shape, exposed via a new `h.ui()` harness accessor.
- [x] Run tests: `npm run test` — must still pass in full (nothing calls the new mock method yet, so no existing behavior should change).
- [x] Run `npm run typecheck` — must pass before next task.

### Task 4: Wire `promptApprovalChoice()` into `promptApproval()`

**Files:**
- Modify: `extensions/index.ts`

- [x] Replace `const choice = await ctx.ui.select(`${icon} ${description}`, options);` in `promptApproval()` with `const choice = await promptApprovalChoice(ctx, `${icon} ${description}`, options);`.
- [x] Verify no other logic in `promptApproval()` changed (diff review against the original function body).
- [x] Confirm the mode-select dialog call (~line 337, `ctx.ui.select("Select permission mode", options)`) and any other `ctx.ui.select`/`ctx.ui.confirm` call sites are untouched.
- [x] Run tests: `npm run test` — all previously-passing approval-flow assertions (`selectCallCount`, `lastSelectPrompt`, `lastSelectOptions`) must pass again, now driven end-to-end through the digit-key path via Task 3's mock. Fix any regex/parsing mismatches surfaced here. Found and fixed a real mismatch: the mock's `custom()` only reconstructed `lastSelectPrompt` from the *first* rendered title line, which broke `testDefaultPromptsForUnsafeBashSyntax`'s case for a command containing a literal embedded newline (`"cat README.md\n touch generated.txt"`), since `promptApprovalChoice()`'s `render()` correctly splits multi-line titles into separate lines. Fixed the mock in `tests/plan-ended-context.test.cjs` to rejoin every raw rendered line up to the first blank separator line with `"\n"`, exactly reconstructing the original title string; updated Task 3's own `testUiCustomMockDrivesDigitSelectionAndTracksPromptOptions` multi-line assertion (previously asserting the old "first line only" behavior) to expect the full rejoined multi-line prompt instead.
- [x] Run `npm run typecheck` — must pass before next task.

### Task 5: Add focused tests for digit/arrow/escape/render-numbering behavior

**Files:**
- Modify: `tests/plan-ended-context.test.cjs`

- [x] Add a test proving a digit key (`"1"`, `"2"`, `"3"`) resolves the corresponding option immediately without requiring Enter (e.g. drive a `toolCall` scenario with a `selectResponses` entry that maps to a specific index, and assert the resulting `block`/session-allow outcome matches that option — reusing existing patterns like `testStrictModeCanBeSelectedByFlag`/session-allow tests as a model). Implemented as `testDigitKeySelectionResolvesCorrespondingOptionOutcome()`.
- [x] Add a test proving Up/Down navigation + Enter still resolves the highlighted option correctly (non-digit path) — e.g. a `selectResponses` entry using a custom function response that drives `handleInput` through arrow moves before Enter, exercising the component directly if the mock design from Task 3 exposes enough hooks, or by asserting on the render output plus a manual `handleInput` sequence against a directly-constructed component instance. Implemented as `testArrowNavigationWrapsAndEnterResolvesHighlightedOption()`, driving a directly-constructed component (via the `makeChoiceFactory()` mirror) through raw arrow/Enter byte sequences.
- [x] Add a test proving a digit outside the option range (e.g. `"9"` with 3 options) is a no-op: dialog does not resolve, `done()` not called. Implemented as `testDigitOutsideOptionRangeIsIgnored()`.
- [x] Add a test proving Escape resolves `undefined` and that `promptApproval()` treats this as Deny (`result.block === true`), following the existing `assertProtectedPathBlock`/`assertCatastrophicBlock` assertion style if applicable, or a new explicit assertion. Implemented as `testEscapeResolvesUndefinedAndTreatedAsDeny()`.
- [x] Add a test asserting the rendered output contains `"1. "`, `"2. "`, `"3. "` with the correct option text — regression guard for the visible numbering itself. Implemented as `testRenderedOutputContainsNumberedOptionLines()`.
- [x] Add a test driving a dangerous/catastrophic bash command through `toolCall` (title containing an embedded `\n` per `describeApprovalRequest`) and asserting the component's `render()` output splits it into separate line entries rather than one raw multi-line string — this is fully automatable (no real keyboard needed) and directly guards the render bug found in plan review. Implemented as `testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines()`, which captures the *real* `promptApprovalChoice()` factory (not the mirror) by temporarily overriding `ctx.ui.custom()`.
- [x] Run tests: `npm run test` — must pass before next task.
- [x] Run `npm run typecheck` — must pass before next task.

### Task 6: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [x] Add a short note in `README.md` wherever the confirmation dialog/approval flow is documented: pressing `1`–`9` on the approval dialog instantly picks that option, in addition to arrows+Enter; Escape still means Deny. Added a feature bullet plus a new "Approval dialog" section (after the `bypassPermissions` mode, before "Installation for local development").
- [x] Add a short note in `CLAUDE.md` under a relevant existing section (or a new small section) documenting the `promptApprovalChoice()` helper and its digit-key behavior as a project convention, so future permission-check changes that touch `promptApproval()` are aware of it. Added a bullet under "Permission Enforcement Invariants".
- [x] Review both diffs to ensure docs match actual implemented behavior (not the sketch in this plan, the real code from Tasks 2-3). Verified against the real `extensions/index.ts` code (`promptApprovalChoice()` ~line 2680, footer hint text, `options` array at ~line 2741 with `"Allow once"` / `"Allow this command for session"` or `"Allow all <tool> for session"` / `"Deny"`) rather than the plan's illustrative sketch.
- [x] Run `npm run typecheck` — must pass before next task.

### Task 7: Verify acceptance criteria

**Files:**
- Modify: `docs/plans/20260702-numbered-approval-choices.md` if implementation scope changed during execution.

- [x] Verify all requirements from Overview are implemented: numbered options visible, digit keys instantly resolve, arrows+Enter still work, Escape still means Deny, mode-select dialog untouched. Confirmed by reading current `extensions/index.ts`: `promptApprovalChoice()` (~line 2680) renders `"${prefix}${i + 1}. ${opt}"` lines (numbered options visible); `handleInput()` checks digit keys 1-9 first via `matchesKey(data, String(i + 1) as KeyId)` and calls `done(options[i])` immediately (instant digit resolve); Up/Down move `selectedIndex` with wrap-around and Enter calls `done(options[selectedIndex])` (arrows+Enter still work); Escape calls `done(undefined)`, and `promptApproval()` (~line 2731) returns `{ block: true, reason: ... }` when `choice` doesn't match `options[0]`/`options[1]` (Escape/Deny still blocks). The mode-select dialog at line 339 (`ctx.ui.select("Select permission mode", options)`) is untouched — still calls `ctx.ui.select`, not `promptApprovalChoice`.
- [x] Verify the `@earendil-works/pi-tui` devDependency resolves correctly and does not affect `npm run pack:dry`'s published file list. `package.json` has `@earendil-works/pi-tui` only under `devDependencies`; `peerDependencies` still lists only `@earendil-works/pi-coding-agent`. `npm run pack:dry` tarball contents: `LICENSE`, `README.md`, `extensions/index.ts`, `gallery.png`, `package.json` — 5 files total, no `node_modules`/dependency listing affected.
- [x] Run full test suite: `npm run test`. Passed — "plan-ended-context tests passed".
- [x] Run typecheck: `npm run typecheck`. Passed with no errors.
- [x] Run package dry-run: `npm run pack:dry`. Succeeded, produced `mkozhin-pi-claude-permissions-0.1.0.tgz` (107.1 kB), tarball contents as listed above; local tarball artifact removed after inspection.
- [x] Run whitespace check: `git diff --check`. Passed (exit code 0, no output — working tree was clean at time of check).
- [x] Optionally run extension load smoke test: `PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'`. Ran successfully — output `No models matching "__no_such_model__"`, no extension load errors.

### Task 8: [Final] Manual TUI verification and completion

**Files:**
- Modify: `docs/plans/20260702-numbered-approval-choices.md`

- [x] manual test (skipped - not automatable by subagent; requires human in live pi TUI session) — Perform the manual TUI verification steps listed under Post-Completion below, in a real `pi` session with this extension loaded (e.g. via `pi -e ./`), and record the outcome (pass/fail per step) directly in this plan file before considering it complete.
- [x] manual test (skipped - not automatable by subagent; requires human in live pi TUI session) — If any manual step fails, treat it as a blocker (`⚠️` prefix), fix, and re-verify — do not mark this task done with a failing manual step.
- [ ] Move this plan to `docs/plans/completed/` once all automated and manual verification has passed. (Left unchecked: the manual TUI verification above has not actually been performed by a human yet — only a subagent skip-note was recorded. Do not move to completed/ until a human runs the Post-Completion steps and confirms pass/fail in this file.)

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes.*

- **Manual TUI verification (required — headless tests cannot prove real keyboard bytes are caught correctly):**
  1. Trigger a bash command confirmation in `default` or `strict` mode.
  2. Press `1` — verify "Allow once" applies instantly, no Enter needed.
  3. Trigger another confirmation; press `2` — verify "Allow for session" applies instantly.
  4. Trigger another confirmation; press `3` — verify "Deny" applies instantly.
  5. Trigger another confirmation; use Up/Down + Enter — verify the arrow-driven flow still works exactly as before.
  6. Trigger another confirmation; press `Esc` — verify it still means Deny.
  7. Resize/use a narrow terminal — verify long command descriptions still wrap/display reasonably and the numbered list isn't visually broken.
  8. Trigger a confirmation for a **dangerous or catastrophic** bash command (e.g. one matching a configured dangerous pattern, or a catastrophic one with `allowCatastrophic` enabled) — verify the multi-line `⚠️ DANGEROUS`/`🚫 CATASTROPHIC` description renders as separate lines correctly (not garbled), and that digit/arrow selection still works on this specific dialog shape.
  9. Repeat steps 2-6 in **both** a terminal with the Kitty keyboard protocol active and a plain legacy terminal (e.g. a Kitty-protocol terminal like Ghostty/Kitty/WezTerm vs. a legacy one like Terminal.app) — `matchesKey`'s digit/escape handling differs by protocol, and this is exactly the class of bug automated tests cannot catch.
  10. Run `/reload` (or restart `pi`) after installing the local extension — verify the extension loads without errors.
- Automated tests and `npm run typecheck` are **not** sufficient evidence that real digit keypresses are caught correctly (Kitty keyboard protocol vs. legacy terminal sequences) — this must be confirmed live, and the result recorded honestly in Task 8, not assumed.
- If using `pi-powerbar` or other extensions that also drive approval-style confirmations, spot-check they aren't affected (this plan only touches this repo's own `promptApproval()`).
