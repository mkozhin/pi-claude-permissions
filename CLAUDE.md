# Project Notes

## Permission Enforcement Invariants

- In `tool_call` handling, always run catastrophic-command and protected-path safety checks before plan/custom/bypass/session/default allow paths.
- `default` mode has its own narrow preapproval path for ordinary read/search/list tools, safe read-only bash, and workflow tools.
- `default` read/search/list preapproval applies only after sensitive-path and configured protected-path checks pass; sensitive direct reads, direct protected reads, and broad directory traversals fall through to confirmation, while protected-path hard blocks apply to bash/write/edit.
- Keep `default` safe-bash preapproval on the dedicated default read-command predicate; do not reuse broader plan-mode bash prefixes for default preapproval. Broad `rg`, recursive `grep`, hidden/unrestricted `fd`, `git diff`, `git log`, and `git show` should prompt in `default`.
- `strict` mode skips the default preapproval path and falls through to confirmation after always-on safety and session approvals.
- Protected-path bash/write/edit blocks are non-overridable and must not be bypassed by `bypassPermissions`, custom modes, or session approvals.
- When adding permission checks, use the shared path-resolution and bash-candidate helpers instead of raw substring checks. Resolve direct paths relative to `ctx.cwd` and `home`, inspect direct path fields plus `pattern`/`name` where relevant, and run bash paths through the candidate/variant helpers so tilde, `$HOME`, globs, and implicit cwd reads stay consistent.
