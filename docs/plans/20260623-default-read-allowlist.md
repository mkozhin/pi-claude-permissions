# Default Read Allowlist and Strict Permission Mode

## Overview
- Add a new built-in `strict` permission mode that preserves the current maximum-confirmation behavior: prompt before almost every tool call unless a hard safety block applies or a session approval exists.
- Change the built-in `default` mode into a practical day-to-day confirmation mode: allow ordinary read/search/list operations without prompting, keep prompting for writes and mutating/suspicious bash, and prompt before reading likely-secret paths.
- Always allow `manage_todo_list` and `ask_user` in `default` mode so workflow extensions can manage todo lists and ask the user without a meta-permission prompt.
- Keep existing always-on catastrophic command and protected-path protections intact across modes.
- Update README documentation so users can discover `strict`, understand the new `default`, and see how `strict` participates in the built-in mode cycle and config.

## Context (from discovery)
- files/components involved:
  - `extensions/index.ts` — mode definitions, tool-call enforcement, plan-mode allowlists, safety helpers, display helpers.
  - `README.md` — user-facing mode descriptions, config example, powerbar display table.
  - `tests/plan-ended-context.test.cjs` and/or new tests under `tests/` — CommonJS TypeScript-transpile harness for extension behavior.
  - `package.json` — `npm run test`, `npm run typecheck`, `npm run pack:dry` validation scripts.
- related patterns found:
  - Built-in modes live in `BUILT_IN_MODES` with `id`, `label`, `description`, and `status`.
  - `default` is the current package default via `const DEFAULT_MODE: PermissionMode = "default"`.
  - Permission enforcement is centralized in `pi.on("tool_call", ...)`.
  - Plan-mode read-only bash uses `SAFE_PLAN_BASH_PREFIXES` + `isSafePlanCommand()`.
  - Always-on safety currently checks catastrophic bash patterns and protected paths for `bash`, `write`, and `edit`.
  - Tests load `extensions/index.ts` through `typescript.transpileModule()` and drive registered Pi hooks with a small harness.
- dependencies identified:
  - Pi extension API hook names: `session_start`, `before_agent_start`, `tool_call`.
  - Optional external tools/extensions are represented by tool names; `manage_todo_list` and `ask_user` may or may not be installed at runtime, so allowing by name must be harmless.
  - `pi-powerbar` integration is event-based and should only need docs/display updates for the new mode.
- key risks / unknowns:
  - Read tool inputs are not fully standardized across every tool (`read.path`, grep/find/ls `path`, bash command paths), so sensitive-read detection should be conservative but not noisy.
  - A bash command that starts with a read-only prefix can still be unsafe if it contains redirection, mutation, or secret-path access; reuse and/or tighten existing safe-command checks.
  - Current working tree is not clean (`extensions/index.ts`, `package.json`, `tests/`, and an unusual `\\` path show as modified/untracked in discovery); implementation should avoid staging unrelated work unless the executor verifies ownership.

## Development Approach
- **testing approach**: Regular — implement focused logic first, then add/update harness tests for the new behavior.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task**.
- **CRITICAL: update this plan file when scope changes during implementation**.
- Run tests after each change.
- Maintain backward compatibility for explicit `defaultMode`, CLI `--permission-mode`, `--dangerously-skip-permissions`, custom modes, plan mode, and existing safety blocks.

## Testing Strategy
- Unit/harness tests required for every behavior-changing task.
- Cover success cases:
  - `default` allows ordinary `read`, `grep`, `find`, `ls`, and safe read-only bash without prompt.
  - `default` allows `manage_todo_list` and `ask_user` without prompt.
  - `strict` prompts for ordinary read/search/list tools.
  - `strict` can be selected by shift-tab and `/permissions` metadata without breaking existing modes.
- Cover error/edge cases:
  - `default` prompts or blocks before reading likely-secret files/paths such as `.env`, `.env.local`, `~/.ssh/config`, `~/.aws/credentials`, `.npmrc`, `.netrc`, `.kube/config`, `.docker/config.json`, `.gnupg`, and credential/token/auth-named files.
  - `default` does not prompt for ordinary non-secret dot paths like `.gitignore` and `.github`.
  - `default` still prompts for `write`, `edit`, and unsafe/mutating bash.
  - catastrophic/protected path blocks still override allowlists.
- No e2e tests are required unless a project e2e harness is discovered later; this change is extension policy logic plus docs.

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Keep plan in sync with actual work.

## Solution Overview
- Use the selected **explicit built-in policy** approach:
  - Add `strict` as a built-in mode.
  - Preserve current broad-prompt behavior under `strict`.
  - Add a small default-mode allowlist path before the general `promptApproval()` call.
- Keep custom modes and plan mode conceptually separate:
  - Plan mode remains read-only and actively scopes `pi.setActiveTools()`.
  - Custom mode policies keep using `enforceCustomMode()`.
  - `default` and `strict` get explicit logic in the central `tool_call` handler because their semantics are built-in and user-facing.
- Introduce helpers with narrow responsibilities:
  - `isAlwaysAllowedWorkflowTool(toolName)` for `manage_todo_list` and `ask_user`.
  - `isDefaultAllowedReadTool(toolName, input, ctx, home)` for ordinary read/search/list tools.
  - `findSensitiveReadReason(toolName, input, ctx, home)` for secret-like read paths and bash commands.
  - Prefer a dedicated `isSafeDefaultReadCommand(command)` for default mode. Reuse `isSafePlanCommand()` only if implementation verifies it permits only ordinary read/list/search commands and does not include broader plan-mode conveniences.
- The tool-call decision order must preserve safety precedence explicitly:
  1. Enforce always-on safety blocks before any allowlist, session approval, custom policy allow, plan-mode allow, or bypass-mode allow can return.
  2. Enforce plan mode if active.
  3. Enforce custom mode if active.
  4. Allow `bypassPermissions` and `acceptEdits` behavior as today, after safety has already run.
  5. Check session-level approvals only after safety has already run.
  6. In `default`, allow workflow tools and non-sensitive read/search/list operations.
  7. Otherwise prompt.
  8. In `strict`, skip the default allowlist and prompt unless session-approved.

## Technical Details
- Built-in modes:
  - Add `{ id: "strict", label: "Strict", description: "Ask before almost every tool call", status: "⏵!" }` or a similarly readable status token.
  - Keep `DEFAULT_MODE` as `"default"`.
  - Default `shiftTabOptions` currently fall back to all built-in modes; adding `strict` intentionally adds it to `/permissions` and the default Shift+Tab cycle unless user config overrides the list.
- Default read tools:
  - Include direct read/search/list tool-call names when Pi exposes them as tools: `read`, `grep`, `find`, `ls`, `rg`, `fd`, `bat`, `eza`.
  - For `bash`, allow only commands that are ordinary read/list/search commands under conservative restrictions: no output redirection except `2>/dev/null`, no append `>>`, no `sed -i`, no `tee`/`sponge`/`dd` write sinks. Prefer a dedicated default-mode predicate over blindly reusing plan-mode behavior.
  - Tighten safe-bash validation for metacharacters/chaining before auto-allowing: test and reject cases like `cat file > out`, `grep x file | tee out`, `find . -exec rm {} \\;`, `cat .env && echo ok`, command substitution that executes mutating commands, and semicolon chains with mutations.
  - Candidate read-only bash prefixes can reuse `SAFE_PLAN_BASH_PREFIXES`, but consider excluding network-ish commands from default auto-allow if they are too broad. If kept, document that default allows read-only metadata commands like `git status`, `git log`, and `npm view` only when they pass the safe-command check.
- Sensitive read detection:
  - Resolve path-like values relative to `ctx.cwd ?? process.cwd()` and `home` when possible.
  - For direct path tools, inspect likely path fields: `path`, `paths`, `file`, `files`, `glob` only when it contains a concrete sensitive segment; avoid treating every glob as secret.
  - For bash, inspect command text for sensitive segments and protected path references before auto-allowing.
  - Secret-like path/name patterns should include:
    - exact or prefix dot env: `.env`, `.env.local`, `.env.production`, etc.
    - home/project credential dirs/files: `.ssh`, `.aws`, `.gnupg`, `.gpg`, `.kube`, `.docker`, `.npmrc`, `.netrc`.
    - token/credential/auth/key names as path segments or whole filename stems, not arbitrary substrings: `credentials`, `credential`, `token`, `secret`, `private_key`, `id_rsa`, `id_ed25519`, `auth.json`, `config.json` under known credential dirs.
  - Explicitly allow ordinary non-secret dot paths such as `.gitignore`, `.github`, `.editorconfig`, `.prettierrc`, and docs/config files unless their name/path also matches a secret pattern.
- Prompting sensitive reads:
  - Sensitive direct reads should not be hard-blocked by default; they should fall through to `promptApproval()` so the user can allow once/session.
  - Protected paths already hard-block bash/write/edit; if direct read tools should also be hard-blocked for configured `protectedPaths`, add this deliberately and test it. Otherwise keep them as prompt-required sensitive reads.
- Always-allowed workflow tools:
  - Add `manage_todo_list` and `ask_user` to a constant such as `DEFAULT_ALWAYS_ALLOWED_TOOLS`.
  - Apply this only in `default`, not in `strict`, unless the implementation deliberately decides `ask_user` should be globally safe. The requirement is specifically for `default`.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, docs updates achievable in this repo.
- **Post-Completion** (no checkboxes): external actions, manual TUI testing, install/reload verification.

## Validation Commands
- focused tests: `npm run test`
- full tests: `npm run test`
- lint/typecheck/build: `npm run typecheck`
- package dry-run: `npm run pack:dry`
- optional extension load smoke test: `PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'`

## Implementation Steps

### Task 1: Add `strict` mode metadata and preserve selection behavior

**Files:**
- Modify: `extensions/index.ts`
- Test: `tests/plan-ended-context.test.cjs` or new `tests/permission-modes.test.cjs`

- [ ] Add `strict` to `BUILT_IN_MODES` with clear label, description, and status indicator.
- [ ] Keep `DEFAULT_MODE` set to `"default"` and verify `normalizeMode()` accepts `strict` through the built-in mode list.
- [ ] Ensure `/permissions` lists `strict` automatically via `modes.map(...)` without special cases.
- [ ] Add/update harness tests proving `strict` is reachable through mode cycling or config/flag normalization behavior.
- [ ] Run focused tests: `npm run test` — must pass before next task.

### Task 2: Refactor tool-call enforcement to distinguish `default` from `strict`

**Files:**
- Modify: `extensions/index.ts`
- Test: `tests/permission-modes.test.cjs` or existing harness test file

- [ ] Adjust `pi.on("tool_call", ...)` so `strict` follows the old current-`default` path: after always-on safety and session-allow checks, call `promptApproval()` for ordinary tools.
- [ ] Keep existing behavior for `plan`, custom modes, `acceptEdits`, and `bypassPermissions` unchanged.
- [ ] Add helper(s) for default-mode pre-approval decisions without mixing them into custom mode policy.
- [ ] Add tests that `strict` prompts for ordinary `read`/`ls`/`grep` while `default` no longer does for non-sensitive reads.
- [ ] Run focused tests: `npm run test` — must pass before next task.

### Task 3: Allow ordinary read/search/list operations in `default`

**Files:**
- Modify: `extensions/index.ts`
- Test: `tests/permission-modes.test.cjs` or existing harness test file

- [ ] Define the direct default read allowlist: `read`, `grep`, `find`, `ls`, `rg`, `fd`, `bat`, `eza`.
- [ ] Allow those tools in `default` only when `findSensitiveReadReason(...)` returns no reason.
- [ ] Allow safe read-only bash in `default` using a dedicated `isSafeDefaultReadCommand()` predicate, or reuse `isSafePlanCommand()` only after verifying it allows only ordinary read/list/search behavior suitable for `default`.
- [ ] Add tests for allowed direct reads/searches and safe bash commands such as `ls`, `grep`, `cat`, `git status`, and `git diff`.
- [ ] Add tests that shell metacharacters/redirection/chaining do not bypass prompting: `cat file > out`, `grep x file | tee out`, `find . -exec rm {} \\;`, command substitution with mutation, and semicolon/`&&` mutation chains.
- [ ] Add tests that `write`, `edit`, and mutating bash still prompt in `default`.
- [ ] Run focused tests: `npm run test` — must pass before next task.

### Task 4: Prompt for sensitive reads in `default`

**Files:**
- Modify: `extensions/index.ts`
- Test: `tests/permission-modes.test.cjs` or existing harness test file

- [ ] Implement secret-like path/name matching for `.env*`, `.ssh`, `.aws`, `.gnupg`, `.gpg`, `.kube`, `.docker`, `.npmrc`, `.netrc`, credential/token/secret/private-key/auth names.
- [ ] Resolve direct tool path inputs relative to `ctx.cwd ?? process.cwd()` and `homedir()` where possible.
- [ ] Inspect bash command text for sensitive path segments before auto-allowing read-only bash.
- [ ] Add tests that `default` prompts for direct reads of `.env`, `.env.local`, `~/.ssh/config`, `.aws/credentials`, `.npmrc`, `.netrc`, `.kube/config`, and token/credential-named files.
- [ ] Add tests that `default` does not prompt for ordinary non-secret dot paths like `.gitignore`, `.github/workflows/publish.yml`, and `.editorconfig`.
- [ ] Run focused tests: `npm run test` — must pass before next task.

### Task 5: Always allow workflow extension tools in `default`

**Files:**
- Modify: `extensions/index.ts`
- Test: `tests/permission-modes.test.cjs` or existing harness test file

- [ ] Add `DEFAULT_ALWAYS_ALLOWED_TOOLS` or equivalent containing `manage_todo_list` and `ask_user`.
- [ ] In `default`, return early for those tools after always-on safety checks and before `promptApproval()`.
- [ ] Confirm this is name-based and harmless when the extensions are not installed; it only affects calls if those tool names exist.
- [ ] Add tests that `default` allows `manage_todo_list` and `ask_user` without invoking `ctx.ui.select`.
- [ ] Add tests that `strict` still prompts for these tools unless the implementation intentionally documents a broader exception.
- [ ] Run focused tests: `npm run test` — must pass before next task.

### Task 6: Regression-test always-on safety precedence and session approvals

**Files:**
- Modify: `extensions/index.ts` if the current order lets any allowlist/session approval run before safety
- Test: `tests/permission-modes.test.cjs` or existing harness test file

- [ ] Ensure catastrophic bash commands are checked before plan-mode allow/deny, custom policy allow, bypass-mode allow, session approvals, and default read/workflow allowlists.
- [ ] Ensure protected path checks still apply to bash/write/edit as before and cannot be bypassed by session approvals.
- [ ] Add protected-path precedence tests against every allow path affected by this change: plan-mode allow/deny, custom policy allow, bypass/acceptEdits allow, session approvals, and default read/workflow allowlists.
- [ ] Verify session-level approvals still work for prompted tools/commands in `default` and `strict` after safety passes.
- [ ] Add regression tests for catastrophic command blocking, protected path blocking, and session allow behavior around the new `default`/`strict` branches.
- [ ] Run focused tests: `npm run test` — must pass before next task.

### Task 7: Update README and user-facing mode documentation

**Files:**
- Modify: `README.md`
- Test: `README.md` documentation review by diff

- [ ] Add a `### strict` section documenting it as the strongest confirmation mode and the replacement for old broad-prompt `default` behavior.
- [ ] Update the `### default` section to describe allowed ordinary reads/searches, sensitive-read prompting, always-allowed `manage_todo_list`/`ask_user`, and continued prompting for writes/mutating bash.
- [ ] Update configuration examples, default Shift+Tab cycle explanation, and valid built-in mode list to state that `strict` is selectable in `/permissions` and included in the default Shift+Tab cycle unless config overrides it.
- [ ] Update powerbar display table to include `strict` with its status label.
- [ ] Review README diff to ensure docs match actual behavior.
- [ ] Run `npm run typecheck` — must pass before next task.

### Task 8: Verify acceptance criteria

**Files:**
- Modify: `docs/plans/20260623-default-read-allowlist.md` if implementation scope changes during execution
- Test: full repo validation commands

- [ ] Verify all requirements from Overview are implemented.
- [ ] Verify `strict` preserves old current-`default` broad prompt behavior.
- [ ] Verify catastrophic and protected-path safety checks run before all allowlists, session approvals, custom mode allowances, plan mode allowances, and bypass behavior.
- [ ] Verify `default` allows ordinary reads/search/list, prompts for sensitive reads, allows `manage_todo_list`/`ask_user`, and still prompts for writes/mutating bash.
- [ ] Run full test suite: `npm run test`.
- [ ] Run typecheck: `npm run typecheck`.
- [ ] Run package dry-run: `npm run pack:dry`.
- [ ] Optionally run extension load smoke test: `PI_OFFLINE=1 pi -e ./ --no-context-files --no-session --list-models '__no_such_model__'`.

### Task 9: [Final] Update documentation and prepare completion

**Files:**
- Modify: `README.md` if final behavior differs from earlier docs edits
- Modify: `docs/plans/20260623-default-read-allowlist.md`

- [ ] Ensure README reflects final exact mode names, display labels, config examples, and safety semantics.
- [ ] Ensure this plan file records any scope changes or blockers discovered during implementation.
- [ ] Check `git diff -- extensions/index.ts README.md tests docs/plans/20260623-default-read-allowlist.md package.json` and avoid staging unrelated pre-existing changes.
- [ ] Ensure plan is ready to move to `docs/plans/completed/` after execution.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes.*

- Restart pi or run `/reload` after installing the local extension to verify runtime behavior in the TUI.
- Use `/permissions` to manually confirm `strict` appears and mode cycling/display behave as expected.
- If using `pi-powerbar`, enable or inspect the `Permissions` segment and verify the new `strict` label is readable.
- Decide whether to include `strict` in personal `piClaudePermissions.shiftTabOptions` if a custom cycle is configured.
- If committing, first inspect the pre-existing dirty working tree and avoid bundling unrelated modifications.
