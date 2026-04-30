# pi-permissions

An opinionated local permissions extension for [pi](https://pi.dev).

This was inspired by [`rHedBull/pi-permissions`](https://github.com/rHedBull/pi-permissions). Big shoutout to rHedBull for the original Claude Code-style permission workflow and the safety checks this builds on.

This version is intentionally more personal and streamlined for my workflow.

## What is different?

- **Only three modes**:
  - `plan`
  - `acceptEdits`
  - `bypassPermissions`
- **No `default` mode**.
- **No `fullAuto` mode**.
- **`bypassPermissions` is the default**.
- **Mode switching is shortcut-only** with `Shift+Tab`.
- **No `/permissions` commands**.
- Includes a custom **plan mode**.

## Modes

### `plan`

Read-only exploration mode.

Allowed tools:

- `read`
- `bash` when the command looks read-only
- `grep`
- `find`
- `ls`
- `rg`
- `fd`
- `bat`
- `eza`

Blocked in plan mode:

- `edit`
- `write`
- mutating bash commands
- anything outside the read/search allowlist

When entering plan mode, the extension notifies:

```text
In plan mode, only read files/search tools are allowed.
```

It also injects visible planning instructions into the next agent turn so the model knows to inspect only and produce a detailed plan.

When leaving plan mode, the extension notifies:

```text
Plan mode ended
```

If you leave plan mode while the agent is idle and there is already at least one assistant response in the session, it sends this user message automatically:

```text
Plan mode ended. Execute the plan.
```

### `acceptEdits`

- Allows `write` and `edit` automatically.
- Prompts for bash commands.
- Still blocks protected paths and catastrophic commands.

### `bypassPermissions`

- Allows normal operations without confirmation.
- Still blocks catastrophic commands and protected paths.
- This is the default mode.

## Shortcut

`Shift+Tab` cycles modes:

```text
plan → acceptEdits → bypassPermissions → plan
```

## Safety checks kept from the inspiration plugin

This keeps the useful always-on protections from `rHedBull/pi-permissions`:

- catastrophic command blocking
- critical `rm -rf` detection
- protected path checks
- shell trick confirmation outside bypass mode
- session-level approvals for prompted operations

## Files

The active local pi extension lives at:

```text
~/.pi/agent/extensions/permission-plan-mode.ts
```

This repository copy lives at:

```text
~/pi-permissions/extensions/index.ts
```

After editing this copy, sync it back to pi with:

```bash
cp ~/pi-permissions/extensions/index.ts ~/.pi/agent/extensions/permission-plan-mode.ts
```

Then reload pi with `/reload` or restart pi.
