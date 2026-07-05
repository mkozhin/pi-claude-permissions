# Fix: Truncate Approval-Dialog Lines to Terminal Width

> **Repository:** `/Users/mkozhin/PycharmProjects/pi-claude-permissions` — a separate, unrelated
> git repository from wherever this plan may have been drafted. All implementation, testing, and
> commits for this plan happen here, not in any other project.

> **Revision note:** an earlier draft of this plan proposed two independent truncation layers — a
> generic tail-cut in `render()` and a "security-aware" middle-truncation in
> `describeApprovalRequest()` sourced from `process.stdout.columns`. Auto-review (plan-review agent)
> found this was broken: the two layers used different width sources, so `render()`'s blind tail-cut
> could silently re-hide the tail that the other layer worked to preserve, and the review's proposed
> test for that layer could not pass as specified. This revision replaces both with a single
> middle-truncation step applied inside `render()` itself, using the one authoritative width the
> host actually passes in. See "Solution Overview" for why this is strictly simpler and correct.

## Overview

`promptApprovalChoice()`'s `render(width)` (extensions/index.ts) receives the real terminal width
from the host but never uses it — it pushes title/option lines into the returned array unmodified.
When content is long enough (observed case: a long bash command combining a deeply-nested
installed-package path with a DAG file path), the resulting line exceeds the actual terminal
width and crashes Pi's TUI with an uncaught exception, ejecting the user from the whole session.

Fix: truncate every line `render(width)` returns to fit `width`, using
`@earendil-works/pi-tui`'s own `visibleWidth`/`truncateToWidth`. Because this is a
security-approval dialog, use **middle**-ellipsis truncation (keep both the start and the end of a
line visible) rather than a blind tail-cut — a long bash command could have a dangerous suffix
(e.g. `... && rm -rf /`) that must not be silently hidden from the person approving it. Applying
this uniformly, inside `render()`, at the one point that actually knows the true width:
guarantees no future crash from this dialog regardless of content source (bash commands,
write/edit paths, option labels, or anything a future call site adds), and reliably preserves
head+tail visibility because there is only one truncation pass, using the one width the host
actually renders at — no second, independently-sourced truncation that could undo it.

Does not change the external contract of `promptApprovalChoice()` or `describeApprovalRequest()`
(same signatures, same return shapes). `describeApprovalRequest()` itself is **not modified** —
see Context below for why.

## Context (from discovery)

- Single extension source file: `extensions/index.ts` (~2818 lines). Single test file:
  `tests/plan-ended-context.test.cjs` (CommonJS, `node:assert/strict`, no external test runner —
  tests are `async function`s invoked manually in an IIFE at the bottom of the file).
- Crash site: `render(width)` inside `promptApprovalChoice()`, `extensions/index.ts:2734-2745`
  (`return lines;` at line 2744).
- `describeApprovalRequest()` is defined *below* `promptApprovalChoice()`/`render()`, at
  `extensions/index.ts:2779-2799` (not "above" as an earlier draft of this plan mis-stated). It is
  called once, synchronously, before the dialog is ever rendered, to build the `title` string that
  `render()`'s closure captures. **It has no access to the eventual render width** — `render(width)`
  may be invoked multiple times with different widths (e.g. on terminal resize) after
  `describeApprovalRequest()` has already run once. This is *why* per-command truncation cannot
  correctly live in `describeApprovalRequest()`: it would have to guess a width
  (`process.stdout.columns`) that can disagree with, and be silently overridden by, whatever
  `render()` later truncates to. The fix belongs entirely inside `render()`, which is the only
  place that ever sees the true, current width.
- `describeApprovalRequest()`'s generic non-bash/non-write/non-edit branch (`describeNonBashApprovalRequest()`)
  already truncates via `truncateApprovalDescription()` (fixed 240-char cap, `extensions/index.ts:2816`)
  — left untouched by this plan. The `write`/`edit`/`bash` branches apply no such cap. This matters
  for a different code path: `promptApprovalChoice()` falls back to `ctx.ui.select(title, options)`
  (no `render()`, no width) whenever `ctx.mode !== "tui"` (e.g. RPC mode) — that path never goes
  through the `render()` fix below, so its pre-existing (partial) truncation stays as-is. Out of
  scope: no crash has been observed or is expected on that path, and it isn't a real terminal that
  needs column-fitting.
- `@earendil-works/pi-tui` is already a devDependency, already imported in this file for
  `matchesKey`/`KeybindingsManager`/`KeyId`. Its main index additionally exports `visibleWidth(str)`,
  `truncateToWidth(text, maxWidth, ellipsis = "...", pad = false)`, and
  `sliceByColumn(line, startCol, length, strict = false)` — all three ANSI/grapheme-column-aware
  (verified by reading `dist/utils.js`'s implementations, not just the type signatures), exactly
  matching what Pi's own crash message pointed at. Verified against
  `node_modules/@earendil-works/pi-tui/dist/index.d.ts:23` and `dist/utils.d.ts:13,63,68`. Note:
  `sliceWithWidth` (a `{text, width}`-returning sibling of `sliceByColumn`) exists in `utils.d.ts`
  but is **not** re-exported from the package's main entry point — only `sliceByColumn` is
  importable from `"@earendil-works/pi-tui"` directly.
- `CLAUDE.md` ("Maintainer Workflow") and the import comment block at the top of
  `extensions/index.ts` (lines 12-19) both currently justify pinning the `pi-tui` devDependency
  version "purely for its `Key`/`matchesKey` exports" — this becomes inaccurate once
  `truncateToWidth`/`visibleWidth` are also imported, and needs a one-line correction.
- Maintainer workflow (`CLAUDE.md`): run `npm run test`, `npm run typecheck`, `npm run pack:dry`,
  and `git diff --check` before shipping permission changes. No lint script exists.
- Existing tests that directly exercise `render()` and must keep passing unchanged:
  `testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines`,
  `testRenderedOutputContainsNumberedOptionLines`. Both use short strings that stay well under
  width 80, so the new truncation is a no-op for them (confirmed during auto-review).
- Existing test helper `withRealApprovalComponent(h, toolName, input, drive)`
  (`tests/plan-ended-context.test.cjs:310`) captures the *real* `render`/`handleInput` component
  from `promptApprovalChoice()` and lets a test call `component.render(<any width>)` directly —
  this is the harness new tests must use. Do **not** use the default `h.ui()` convenience mock's
  `custom()`, which hardcodes `render(80)` internally (`tests/plan-ended-context.test.cjs:156`) and
  doesn't expose the raw lines to assert on.

## Development Approach

- **Testing approach:** Regular (implement, then extend tests in the same task) — matches this
  repo's existing convention of one incrementally-grown test file.
- Surgical scope only: `extensions/index.ts` (import line, one new helper function, `render()`
  body, two comment corrections) + `tests/plan-ended-context.test.cjs` (one new import, three new
  tests) + `CLAUDE.md` (one bullet correction). `describeApprovalRequest()` is **not** touched.
  No other refactor, no new abstractions beyond the one named helper.
- Run `npm run test` after each task; do not proceed to the next task with failing tests.

## Testing Strategy

- Behavioral tests only, via the existing `tests/plan-ended-context.test.cjs` harness — no new
  test framework or file.
- Must keep 100% of existing tests passing, in particular the two listed above that directly poke
  `render()`.
- Three new tests, all driven through `withRealApprovalComponent` so the test controls the exact
  width passed to `render()`:
  - proves no rendered line ever exceeds the width passed to `render()`, across a range of widths
    including degenerate ones (`0`-`4`) where a naive ellipsis-always-inserted implementation
    would overflow even though `budget` collapses to zero,
  - proves middle-truncation genuinely elides the middle: uses three distinct markers (start,
    middle, end) in a long command, and asserts the start/end markers survive in some rendered
    line while the middle marker never appears in any rendered line. (An earlier draft asserted "no
    unbroken run of 20+ repeated characters" — auto-review showed that check is unreliable, since a
    correct implementation's head/tail slices legitimately retain long runs of the padding
    character by construction. Distinct markers avoid that false-negative.)
  - proves truncation also fits a non-bash content source (`edit`'s long `path`), so the acceptance
    claim of covering "bash, write, edit, options" is actually backed by a test rather than only by
    a `bash`-specific one.
- ANSI-escape safety (the reason `sliceByColumn` replaces the old hand-rolled tail slice) is **not**
  separately exercised by these tests: both the default mock's `fakeTheme.fg` and
  `withRealApprovalComponent`'s all feed unstyled strings through, so `truncateLineMiddle` only ever
  sees plain text in the suite. This property rests on `sliceByColumn`'s own (verified) ANSI
  handling in `pi-tui`, confirmed by manual/out-of-band testing during plan review, not on a test
  added by this plan. Adding a styled-input test would require extending the harness's fake theme,
  which is out of this plan's deliberately surgical scope.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix; document blockers with ⚠️ prefix.

## Solution Overview

One truncation helper (`truncateLineMiddle`), applied to every line `render()` returns, using the
`width` argument `render()` already receives. No second, independently-sourced truncation pass —
this is the direct fix for the auto-review's core finding (two width sources can disagree and one
can silently undo the other). Lines that already fit are returned unchanged (early-exit inside the
helper), so option labels and the footer hint are unaffected at normal terminal widths, where they
already fit comfortably; at pathologically narrow widths they would be truncated like any other
line, which is correct — the helper does not special-case them.

## Technical Details

**Import** (`extensions/index.ts:20`):
```ts
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
```

**New helper** (place directly above `promptApprovalChoice()`, i.e. above line ~2682 — this is
the only place it's used):
```ts
// Approval dialogs must not silently hide the end of a long line (e.g. a bash command's
// dangerous appended suffix) behind a naive tail-cut. Elides the middle instead, keeping both
// ends visible, sized to the real render width the caller passes in.
//
// Uses sliceByColumn() (not a hand-rolled slice) for both head and tail: lines pushed into
// render()'s output are already ANSI-styled via theme.fg(...) before truncation ever runs, so
// a byte/char-index slice could cut an escape sequence in half. sliceByColumn() is
// ANSI/grapheme-column-aware, matching how truncateToWidth() already handles the head.
function truncateLineMiddle(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(line) <= maxWidth) return line;

  const ellipsis = " … ";
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) {
    // Not enough room for a full ellipsis at this width — shrink it instead of overflowing.
    return truncateToWidth(ellipsis, maxWidth, "");
  }

  const budget = maxWidth - ellipsisWidth;
  const headWidth = Math.ceil(budget * 0.6);
  const tailWidth = budget - headWidth;
  const head = truncateToWidth(line, headWidth, "");
  const lineWidth = visibleWidth(line);
  const tail = sliceByColumn(line, Math.max(0, lineWidth - tailWidth), tailWidth);
  return `${head}${ellipsis}${tail}`;
}
```

**`render(width)` fix** — replace the final `return lines;` (line 2744) with:
```ts
return lines.map((line) => truncateLineMiddle(line, width));
```

`describeApprovalRequest()` (lines 2779-2799) is **not modified** — see Context above.

## What Goes Where

- **Implementation Steps:** code changes, helper functions, doc-comment accuracy fixes, new tests —
  all achievable within this repo.
- **Post-Completion:** none required — this is a self-contained local extension with no deploy
  pipeline or consuming-project updates.

## Implementation Steps

### Task 1: Add middle-truncation to `render()` using the real terminal width

**Files:**
- Modify: `extensions/index.ts`
- Modify: `tests/plan-ended-context.test.cjs`

- [x] extend the existing `import { matchesKey } from "@earendil-works/pi-tui";` (line 20) to also
      import `sliceByColumn`, `truncateToWidth`, and `visibleWidth`
- [x] add the `truncateLineMiddle` helper directly above `promptApprovalChoice()` (per Technical
      Details) — note it now uses `sliceByColumn` for the tail instead of a hand-rolled
      char-slice loop, and guards `maxWidth <= 0` plus the case where the ellipsis itself is
      wider than `maxWidth`
- [x] in `render(width)` inside `promptApprovalChoice()` (line 2744), replace `return lines;` with
      `return lines.map((line) => truncateLineMiddle(line, width));`
- [x] import `visibleWidth` from `@earendil-works/pi-tui` at the top of
      `tests/plan-ended-context.test.cjs`, alongside the existing
      `const { KeybindingsManager, TUI_KEYBINDINGS } = require(...)`
- [x] write `testRenderTruncatesLongLinesToFitWidth`: via
      `withRealApprovalComponent(h, "bash", { command: "echo " + "x".repeat(400) }, (component) => {...})`,
      call `component.render(w)` inside the drive callback **for each width in
      `[0, 1, 2, 3, 4, 10, 80]`**, then `component.handleInput("1")` so `h.toolCall()` resolves;
      assert every line returned by every one of those `render(w)` calls has
      `visibleWidth(line) <= w` — this specifically catches the small-width case where a naive
      implementation still emits a full-width ellipsis wider than `w`. Note: uses
      `h.setFlag("permission-mode", "strict")` rather than `"default"` — `"echo"` is on the
      default-mode safe-bash allowlist, so under `"default"` this command would be preapproved
      without ever reaching `ctx.ui.custom()`; `"strict"` forces confirmation regardless of
      command content, matching the existing `testStrictPromptsForOrdinaryReadTools` convention.
- [x] write `testLongBashCommandTruncationPreservesHeadAndTail`: build a command with three
      distinct markers separated by long filler, e.g.
      `"echo START_MARKER_" + "x".repeat(140) + "_MIDDLE_MARKER_" + "x".repeat(140) + "_END_MARKER"`;
      run it through `withRealApprovalComponent` the same way, call `component.render(80)`; assert
      (a) some rendered line contains both `"START_MARKER"` and `"END_MARKER"`, and (b) no rendered
      line contains `"MIDDLE_MARKER"` (proves the middle was actually elided, not that the string
      happened to fit). Same `"strict"`-mode note as above applies (command also starts with
      `"echo"`).
- [x] write `testLongEditPathTruncatesToFitWidth`: via
      `withRealApprovalComponent(h, "edit", { path: "/very/deeply/nested/" + "segment/".repeat(30) + "file.ts" }, (component) => {...})`,
      call `component.render(80)`, assert every line has `visibleWidth(line) <= 80` — this is the
      test that actually backs Task 2's "covered for bash, write, edit, options" claim for a
      non-bash content source (the existing short-string `write`/`edit` tests never exercise
      truncation at all)
- [x] add all three new tests' invocations to the IIFE test list at the bottom of the file, after
      `testTuiModeStillUsesCustomDialog()`
- [x] run `npm run test` from `/Users/mkozhin/PycharmProjects/pi-claude-permissions` — all existing
      tests plus all three new ones must pass before Task 2

### Task 2: Verify acceptance criteria

- [x] verify `render(width)` truncates every line to fit, across a range of widths including
      degenerate ones (`0`-`4`) — covered by Task 1's first new test
      (`testRenderTruncatesLongLinesToFitWidth`)
- [x] verify `render(width)` truncates long content for both `bash` and non-bash tools (`edit`) —
      covered by Task 1's first and third new tests (`testRenderTruncatesLongLinesToFitWidth`,
      `testLongEditPathTruncatesToFitWidth`); short-string existing tests
      (`testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines`,
      `testRenderedOutputContainsNumberedOptionLines`) confirm truncation stays a no-op when
      content already fits, but do not themselves exercise truncation
- [x] verify long bash commands remain legible at both ends after truncation — covered by Task 1's
      second new test (`testLongBashCommandTruncationPreservesHeadAndTail`)
- [x] run full test suite: `npm run test` (from `/Users/mkozhin/PycharmProjects/pi-claude-permissions`)
- [x] run `npm run typecheck` (same directory)
- [x] run `npm run pack:dry` and `git diff --check` per `CLAUDE.md`'s Maintainer Workflow

### Task 3: [Final] Correct stale comments and update documentation

**Files:**
- Modify: `extensions/index.ts`
- Modify: `CLAUDE.md`

- [x] update the import comment block at the top of `extensions/index.ts` (lines 12-19) to mention
      `sliceByColumn`/`truncateToWidth`/`visibleWidth` alongside `Key`/`matchesKey` as reasons this
      devDependency must stay version-pinned to the host's bundled `pi-tui`
- [x] update `CLAUDE.md`'s "Maintainer Workflow" bullet (line 20) the same way — replace "purely
      for its `Key`/`matchesKey` exports" with wording that also covers the width-truncation
      utilities (`sliceByColumn`, `truncateToWidth`, `visibleWidth`)
- [x] add one brief sentence to the `render()`-related paragraph under "Permission Enforcement
      Invariants" (`CLAUDE.md` line 13) noting that `render()` now middle-truncates every line to
      the given width — keep it to one sentence, this documents already-shipped behavior, it isn't
      introducing a new invariant to design around
- [x] no README.md change expected — this is an internal robustness fix, not a user-facing feature
- [x] run `npm run test` once more to confirm nothing broke from the comment edits
- [x] (deferred to orchestrator's move-plan step)

## Post-Completion

*No items — self-contained local extension fix with no deployment pipeline, consuming-project
updates, or external verification needed.*
