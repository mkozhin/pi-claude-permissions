# Project Notes

## Permission Enforcement Invariants

- In `tool_call` handling, always run catastrophic-command and protected-path safety checks before plan/custom/bypass/session/default allow paths.
- `default` mode has its own narrow preapproval path for ordinary read/search/list tools, safe read-only bash, and workflow tools.
- `default` read/search/list preapproval applies only after sensitive-path and configured protected-path checks pass; sensitive direct reads, direct protected reads, and broad directory traversals fall through to confirmation, while protected-path hard blocks apply to bash/write/edit.
- Keep `default` safe-bash preapproval on the dedicated default read-command predicate; do not reuse broader plan-mode bash prefixes for default preapproval. Broad `rg`, recursive `grep`, hidden/unrestricted `fd`, `git diff`, `git log`, and `git show` should prompt in `default`.
- `strict` mode skips the default preapproval path and falls through to confirmation after always-on safety and session approvals.
- Protected-path bash/write/edit blocks are non-overridable and must not be bypassed by `bypassPermissions`, custom modes, or session approvals.
- When adding permission checks, use the shared path-resolution and bash-candidate helpers instead of raw substring checks. Resolve direct paths relative to `ctx.cwd` and `home`, inspect direct path fields plus `pattern`/`name` where relevant, and run bash paths through the candidate/variant helpers so tilde, `$HOME`, globs, and implicit cwd reads stay consistent.
- Plan-mode bash uses `SAFE_PLAN_BASH_PREFIXES` plus option guards in `hasUnsafePlanCommandOptions`. Generic `curl`, `sed`, `awk`, `env`, generic `gh api`, command substitution, control-flow chaining, output-writing options, `find`/`fd` exec or delete options, `rg --pre`, unsafe `bat` pager/config options, `git --output`/`--ext-diff`/`--textconv`, and special device reads are not plan-safe. Adding a safe prefix must include write/network/output option review and regression tests; commands that can execute subcommands or mutate external services should stay out of the prefix list.
- Approval confirmation dialogs are rendered by `promptApprovalChoice()` (`extensions/index.ts`), a custom `ctx.ui.custom()` component wrapped by `promptApproval()` — not `ctx.ui.select()`. It supports digit keys `1`-`9` for instant selection (checked first in `handleInput`), plus Up/Down-with-wrap and Enter to confirm the highlighted option, and Escape to resolve `undefined` (Deny), matching the return contract `promptApproval()` expects. The mode-select dialog (`ctx.ui.select("Select permission mode", ...)`) and all other `ctx.ui.select`/`ctx.ui.confirm` call sites are unaffected and keep arrow-keys-only behavior. Any future change to `promptApproval()`'s dialog must preserve this digit-key behavior and its return contract, and `render()` must keep splitting multi-line titles (e.g. dangerous/catastrophic bash descriptions) into separate lines rather than pushing one raw multi-line string.

## Maintainer Workflow

- Run `npm run test`, `npm run typecheck`, `npm run pack:dry`, and `git diff --check` before shipping permission changes.
- There is no lint script in this package.
- Permission behavior tests currently live in `tests/plan-ended-context.test.cjs` and load `extensions/index.ts` through TypeScript transpilation.
