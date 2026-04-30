/**
 * Opinionated Permissions + Plan Mode for pi
 *
 * Inspired by rHedBull/pi-permissions, trimmed down for this workflow:
 * - Shift+Tab cycles modes.
 * - Default mode is bypassPermissions.
 * - Plan mode is read-only and injects planning instructions.
 * - Leaving plan mode for acceptEdits while idle asks the agent to execute.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";
type Pattern = { pattern: string; description: string };
type UiContext = {
  ui: any;
  hasUI?: boolean;
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  sessionManager?: { getEntries?: () => Array<any> };
};

interface SessionAllow {
  tools: Set<string>;
  commands: Set<string>;
}

interface PermissionsConfig {
  mode?: string;
  dangerousPatterns?: Pattern[];
  catastrophicPatterns?: Pattern[];
  protectedPaths?: string[];
}

const DEFAULT_MODE: PermissionMode = "bypassPermissions";
const PLAN_EXIT_PROMPT = "Plan mode ended. Execute the plan.";
const PLAN_BLOCK_REASON = "You are in plan mode, you can only read files/search tools until the user exits plan mode.";

const MODES: Array<{ id: PermissionMode; label: string; description: string; status: string }> = [
  { id: "plan", label: "Plan", description: "Read-only exploration; only read/search tools and safe bash", status: "⏸" },
  { id: "acceptEdits", label: "Accept Edits", description: "Allow write/edit silently, confirm bash", status: "⏵⏵" },
  { id: "bypassPermissions", label: "Bypass Permissions", description: "Allow everything except catastrophic/protected operations", status: "⏵⏵⏵⏵" },
];

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "rg", "fd", "bat", "eza"];
const GATED_TOOLS = new Set(["write", "edit", "bash"]);

const SAFE_PLAN_BASH_PREFIXES = [
  "cat", "head", "tail", "less", "more", "grep", "find", "ls",
  "pwd", "echo", "printf", "wc", "sort", "uniq", "diff", "file",
  "stat", "du", "df", "tree", "which", "whereis", "type", "env",
  "printenv", "uname", "whoami", "id", "date", "cal", "uptime",
  "ps", "top", "htop", "free", "curl", "jq", "sed", "awk",
  "rg", "fd", "bat", "eza", "git status", "git log", "git diff",
  "git show", "git branch", "git remote", "git ls-", "git config --get",
  "gh pr view", "gh pr list", "gh pr diff", "gh pr checks", "gh pr status",
  "gh issue view", "gh issue list", "gh issue status", "gh repo view",
  "gh run view", "gh run list", "gh release view", "gh release list",
  "gh api", "gh auth status", "npm list", "npm ls", "npm view",
  "npm info", "npm search", "npm outdated", "npm audit",
];

const DEFAULT_DANGEROUS: Pattern[] = [
  { pattern: "chmod -R 777", description: "insecure recursive permissions" },
  { pattern: "chown -R", description: "recursive ownership change" },
  { pattern: "> /dev/", description: "direct device write" },
];

const DEFAULT_CATASTROPHIC: Pattern[] = [
  { pattern: "sudo mkfs", description: "sudo filesystem format" },
  { pattern: "mkfs.", description: "filesystem format" },
  { pattern: "dd if=", description: "raw disk write" },
  { pattern: ":(){ :|:& };:", description: "fork bomb" },
  { pattern: "> /dev/sda", description: "overwrite disk" },
  { pattern: "> /dev/nvme", description: "overwrite disk" },
  { pattern: "sudo dd", description: "sudo raw disk operation" },
];

const CRITICAL_DIRS = [
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt",
  "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var",
];

const DEFAULT_PROTECTED_PATHS = [
  "~/.ssh", "~/.aws", "~/.gnupg", "~/.gpg", "~/.bashrc", "~/.bash_profile",
  "~/.profile", "~/.zshrc", "~/.zprofile", "~/.config/git/credentials",
  "~/.netrc", "~/.npmrc", "~/.docker/config.json", "~/.kube/config", "~/.pi/agent/auth.json",
];

const SHELL_TRICK_PATTERNS = [
  { pattern: /\$\(/, description: "command substitution $(…)" },
  { pattern: /`[^`]+`/, description: "backtick command substitution" },
  { pattern: /\beval\b/, description: "eval execution" },
  { pattern: /\bbash\s+-c\b/, description: "bash -c execution" },
  { pattern: /\bsh\s+-c\b/, description: "sh -c execution" },
  { pattern: /\|\s*(ba)?sh\b/, description: "pipe to shell" },
  { pattern: /\bexec\b/, description: "exec execution" },
  { pattern: /\bsource\b/, description: "source execution" },
  { pattern: />\(/, description: "process substitution >(…)" },
  { pattern: /<\(/, description: "process substitution <(…)" },
];

const PLAN_MODE_MESSAGE = `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash (read-only), grep, find, ls, rg, fd, bat, eza
- You CANNOT use: edit, write, or any file modification tool
- Bash is restricted to read-only commands (no >, >>, tee, sed -i, etc.)

Instructions:
- Produce a COMPLETE, DETAILED PLAN for the user's request before they exit plan mode.
- Read and search files freely to understand the codebase.
- Do NOT attempt to make any changes — just describe what you would do step by step.
- The user will switch out of plan mode (Shift+Tab) when they are ready to execute the plan.
- Be thorough: include file paths, function names, and specific changes needed.`;

export default async function permissionExtension(pi: ExtensionAPI) {
  pi.registerFlag("permission-mode", {
    description: "Permission mode (plan, acceptEdits, bypassPermissions)",
    type: "string",
    default: "",
  });
  pi.registerFlag("dangerously-skip-permissions", {
    description: "Bypass all permission checks except catastrophic/protected checks",
    type: "boolean",
    default: false,
  });

  const config = await loadConfig();
  const home = homedir();
  const sessionAllow: SessionAllow = { tools: new Set(), commands: new Set() };
  const dangerousPatterns = config.dangerousPatterns ?? DEFAULT_DANGEROUS;
  const catastrophicPatterns = config.catastrophicPatterns ?? DEFAULT_CATASTROPHIC;
  const protectedPaths = (config.protectedPaths ?? DEFAULT_PROTECTED_PATHS).map((path) =>
    path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(path),
  );

  let mode = normalizeMode(config.mode);
  let previousActiveTools: string[] | null = null;
  let planContextPending = mode === "plan";

  const clearSessionAllows = () => {
    sessionAllow.tools.clear();
    sessionAllow.commands.clear();
  };

  const restoreToolsAfterPlan = () => {
    if (!previousActiveTools) return;
    pi.setActiveTools(previousActiveTools);
    previousActiveTools = null;
  };

  const enterPlanToolScope = () => {
    if (!previousActiveTools) previousActiveTools = pi.getActiveTools();
    pi.setActiveTools(PLAN_MODE_TOOLS);
  };

  const updateStatus = (ctx: UiContext) => {
    const meta = getModeMeta(mode);
    ctx.ui.setStatus("permissions", `${meta.status} ${meta.label}`);
  };

  const applyMode = (nextMode: PermissionMode, ctx: UiContext) => {
    const wasPlan = mode === "plan";
    const enteringPlan = nextMode === "plan" && !wasPlan;
    const leavingPlan = wasPlan && nextMode !== "plan";
    const shouldExecutePlan = leavingPlan
      && ctx.isIdle?.() === true
      && ctx.hasPendingMessages?.() !== true
      && hasPriorAssistantResponse(ctx);

    mode = nextMode;
    clearSessionAllows();

    if (enteringPlan || nextMode === "plan") {
      enterPlanToolScope();
      planContextPending = true;
      ctx.ui.notify("In plan mode, only read files/search tools are allowed.", "info");
    } else {
      if (leavingPlan) {
        restoreToolsAfterPlan();
        planContextPending = false;
        ctx.ui.notify("Plan mode ended", "info");
      }
      ctx.ui.notify(`Permission mode: ${getModeMeta(mode).label}`, "info");
    }

    updateStatus(ctx);
    if (shouldExecutePlan) pi.sendUserMessage(PLAN_EXIT_PROMPT);
  };

  pi.on("session_start", async (_event, ctx) => {
    clearSessionAllows();

    if (pi.getFlag("dangerously-skip-permissions") === true) {
      mode = "bypassPermissions";
    } else {
      const flagMode = pi.getFlag("permission-mode");
      if (typeof flagMode === "string" && flagMode) mode = normalizeMode(flagMode);
    }

    if (mode === "plan") {
      enterPlanToolScope();
      planContextPending = true;
    } else {
      restoreToolsAfterPlan();
      planContextPending = false;
    }

    updateStatus(ctx);
  });

  pi.registerShortcut("shift+tab", {
    description: "Cycle permission mode (plan → accept edits → bypass permissions)",
    handler: async (ctx) => {
      const idx = MODES.findIndex((m) => m.id === mode);
      applyMode(MODES[(idx + 1) % MODES.length]!.id, ctx);
    },
  });

  pi.on("before_agent_start", async () => {
    if (mode !== "plan" || !planContextPending) return;
    planContextPending = false;
    return {
      message: {
        customType: "plan-mode-context",
        content: PLAN_MODE_MESSAGE,
        display: true,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    if (mode === "plan") return enforcePlanMode(toolName, event.input);
    if (!GATED_TOOLS.has(toolName)) return;

    const safetyBlock = await enforceAlwaysOnSafety({
      toolName,
      input: event.input,
      ctx,
      home,
      protectedPaths,
      catastrophicPatterns,
    });
    if (safetyBlock) return safetyBlock;

    if (mode === "bypassPermissions") return;
    if (mode === "acceptEdits" && (toolName === "write" || toolName === "edit")) return;

    const shellTrickBlock = await maybeConfirmShellTrick(toolName, event.input, ctx);
    if (shellTrickBlock) return shellTrickBlock;

    if (isSessionAllowed(toolName, event.input, sessionAllow)) return;

    if (!ctx.hasUI) {
      return { block: true as const, reason: `Blocked ${toolName} (no UI for confirmation, mode: ${mode})` };
    }

    return promptApproval(toolName, event.input, ctx, dangerousPatterns, catastrophicPatterns, sessionAllow);
  });
}

async function loadConfig(): Promise<PermissionsConfig> {
  const globalPath = resolve(homedir(), ".pi/agent/extensions/permissions.json");
  const localPath = resolve(process.cwd(), ".pi/extensions/permissions.json");
  const global = await readJson<PermissionsConfig>(globalPath);
  const local = await readJson<PermissionsConfig>(localPath);

  return {
    mode: normalizeMode(local.mode ?? global.mode),
    dangerousPatterns: local.dangerousPatterns ?? global.dangerousPatterns ?? DEFAULT_DANGEROUS,
    catastrophicPatterns: local.catastrophicPatterns ?? global.catastrophicPatterns ?? DEFAULT_CATASTROPHIC,
    protectedPaths: local.protectedPaths ?? global.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
  };
}

async function readJson<T>(path: string): Promise<T | Record<string, never>> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

function normalizeMode(mode: unknown): PermissionMode {
  return mode === "plan" || mode === "acceptEdits" || mode === "bypassPermissions" ? mode : DEFAULT_MODE;
}

function getModeMeta(mode: PermissionMode) {
  return MODES.find((m) => m.id === mode)!;
}

function enforcePlanMode(toolName: string, input: Record<string, unknown>) {
  if (!PLAN_MODE_TOOLS.includes(toolName)) return { block: true as const, reason: PLAN_BLOCK_REASON };
  if (toolName === "bash" && !isSafePlanCommand(String(input.command ?? ""))) {
    return { block: true as const, reason: PLAN_BLOCK_REASON };
  }
}

async function enforceAlwaysOnSafety(args: {
  toolName: string;
  input: Record<string, unknown>;
  ctx: UiContext;
  home: string;
  protectedPaths: string[];
  catastrophicPatterns: Pattern[];
}) {
  const { toolName, input, ctx, home, protectedPaths, catastrophicPatterns } = args;

  if (toolName === "bash") {
    const command = String(input.command ?? "");
    const criticalRm = checkCriticalRmRf(command);
    if (criticalRm) {
      ctx.ui.notify(`🚫 Blocked catastrophic command: ${criticalRm}`, "error");
      return { block: true as const, reason: `Catastrophic command blocked: ${criticalRm}. This cannot be overridden.` };
    }

    const catastrophe = findMatch(command, catastrophicPatterns);
    if (catastrophe) {
      ctx.ui.notify(`🚫 Blocked catastrophic command: ${catastrophe.description}`, "error");
      return { block: true as const, reason: `Catastrophic command blocked: ${catastrophe.description}. This cannot be overridden.` };
    }

    const protectedPath = protectedPaths.find((path) => command.includes(path) || command.includes(path.replace(home, "~")));
    if (protectedPath) {
      const readable = protectedPath.replace(home, "~");
      ctx.ui.notify(`🚫 Blocked bash targeting protected path: ${readable}`, "error");
      return { block: true as const, reason: `Bash command references protected path ${readable}. This cannot be overridden.` };
    }
  }

  if (toolName === "write" || toolName === "edit") {
    const targetPath = resolve(String(input.path ?? ""));
    const protectedPath = protectedPaths.find((path) => targetPath === path || targetPath.startsWith(path + "/"));
    if (protectedPath) {
      ctx.ui.notify(`🚫 Blocked write to protected path: ${targetPath}`, "error");
      return { block: true as const, reason: `Protected path blocked: ${targetPath}. This cannot be overridden.` };
    }
  }
}

async function maybeConfirmShellTrick(toolName: string, input: Record<string, unknown>, ctx: UiContext) {
  if (toolName !== "bash") return;

  const command = String(input.command ?? "");
  const trick = SHELL_TRICK_PATTERNS.find((pattern) => pattern.pattern.test(command));
  if (!trick) return;

  if (!ctx.hasUI) return { block: true as const, reason: `Blocked shell trick: ${trick.description} (no UI for confirmation)` };

  const displayCmd = command.length > 200 ? command.slice(0, 200) + "…" : command;
  const choice = await ctx.ui.select(`⚠️ bash: ${displayCmd}\n   ⚠️  SHELL TRICK: ${trick.description}`, ["Allow once", "Deny"]);
  if (choice !== "Allow once") return { block: true as const, reason: `User denied shell trick: ${trick.description}` };
}

function isSessionAllowed(toolName: string, input: Record<string, unknown>, sessionAllow: SessionAllow): boolean {
  if (toolName === "bash" && sessionAllow.commands.has(String(input.command ?? ""))) return true;
  return sessionAllow.tools.has(toolName);
}

function hasPriorAssistantResponse(ctx: UiContext): boolean {
  return ctx.sessionManager?.getEntries?.().some((entry) =>
    entry?.type === "message" && entry.message?.role === "assistant",
  ) === true;
}

function isSafePlanCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || />>/.test(trimmed) || /sed\s+.*-i/.test(trimmed)) return false;

  for (const match of trimmed.matchAll(/>/g)) {
    const idx = match.index!;
    if (idx > 0 && trimmed[idx - 1] === "2" && trimmed.slice(idx + 1).startsWith("/dev/null")) continue;
    return false;
  }

  if (["tee", "sponge", "dd"].some((cmd) => trimmed.includes(`| ${cmd}`) || trimmed.includes(`| sudo ${cmd}`))) {
    return false;
  }

  return SAFE_PLAN_BASH_PREFIXES.some((prefix) => trimmed.startsWith(prefix) || trimmed.includes(`| ${prefix}`));
}

function checkCriticalRmRf(command: string): string | null {
  for (const pattern of rmRfPatterns()) {
    const match = command.match(pattern);
    if (!match) continue;

    const home = homedir();
    const targets = match[1]!.trim().split(/\s+/).filter((target) => !target.startsWith("-"));

    for (const target of targets) {
      const resolved = resolveAbsoluteShellTarget(target, home);
      if (!resolved) continue;

      const normalized = resolved.replace(/\/+$/, "") || "/";
      if (normalized === "/") return "rm -rf / — recursive delete root";
      if (normalized === home) return "rm -rf ~ — recursive delete entire home directory";
      if (CRITICAL_DIRS.includes(normalized)) return `rm -rf ${normalized} — recursive delete critical system directory`;
    }
  }

  if (/\bsudo\s+/.test(command)) {
    const nested = checkCriticalRmRf(command.replace(/\bsudo\s+/, ""));
    if (nested) return `sudo ${nested}`;
  }

  return null;
}

function checkDangerousRmRf(command: string, cwd: string): { description: string } | null {
  for (const pattern of rmRfPatterns()) {
    const match = command.match(pattern);
    if (!match) continue;

    const rawArgs = match[1]!.trim().split(/\s*(?:&&|\|\||[;|])\s*/)[0]!;
    const targets = rawArgs.split(/\s+/).filter((target) => !target.startsWith("-") && target.length > 0);
    const normalizedCwd = resolve(cwd);

    for (const target of targets) {
      const normalized = resolveShellTarget(target, cwd);
      if (normalized === normalizedCwd || normalized.startsWith(normalizedCwd + "/")) continue;
      return { description: `recursive force delete outside project (${target})` };
    }

    return null;
  }

  return null;
}

function rmRfPatterns() {
  return [
    /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(.*)/i,
    /\brm\s+-r\s+-f\s+(.*)/i,
    /\brm\s+-f\s+-r\s+(.*)/i,
  ];
}

function resolveAbsoluteShellTarget(target: string, home = homedir()): string | null {
  if (target === "~") return home;
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  if (target === "/*") return "/";
  if (target.startsWith("/")) return target;
  return null;
}

function resolveShellTarget(target: string, cwd: string): string {
  const home = homedir();
  if (target === "~") return home;
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  if (target.startsWith("/")) return resolve(target);
  return resolve(cwd, target);
}

function findMatch(command: string, patterns: Pattern[]): Pattern | undefined {
  return patterns.find((pattern) => command.includes(pattern.pattern));
}

async function promptApproval(
  toolName: string,
  input: Record<string, unknown>,
  ctx: UiContext,
  dangerousPatterns: Pattern[],
  catastrophicPatterns: Pattern[],
  sessionAllow: SessionAllow,
): Promise<{ block: true; reason: string } | undefined> {
  const { icon, description } = describeApprovalRequest(toolName, input, dangerousPatterns, catastrophicPatterns);
  const options = [
    "Allow once",
    toolName === "bash" ? "Allow this command for session" : `Allow all ${toolName} for session`,
    "Deny",
  ];

  const choice = await ctx.ui.select(`${icon} ${description}`, options);
  if (choice === options[0]) return;

  if (choice === options[1]) {
    if (toolName === "bash") sessionAllow.commands.add(String(input.command ?? ""));
    else sessionAllow.tools.add(toolName);
    return;
  }

  return { block: true, reason: `User denied ${toolName}` };
}

function describeApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
  dangerousPatterns: Pattern[],
  catastrophicPatterns: Pattern[],
): { icon: string; description: string } {
  if (toolName === "write") return { icon: "🔒", description: `write: ${input.path}` };
  if (toolName === "edit") return { icon: "🔒", description: `edit: ${input.path}` };
  if (toolName !== "bash") return { icon: "🔒", description: toolName };

  const command = String(input.command ?? "");
  const displayCmd = command.length > 200 ? command.slice(0, 200) + "…" : command;
  const catastrophe = findMatch(command, catastrophicPatterns);
  const danger = findMatch(command, dangerousPatterns);
  const rmDanger = checkDangerousRmRf(command, process.cwd());

  if (catastrophe) return { icon: "🚫", description: `bash: ${displayCmd}\n   🚫 CATASTROPHIC: ${catastrophe.description}` };
  if (danger) return { icon: "⚠️", description: `bash: ${displayCmd}\n   ⚠️  DANGEROUS: ${danger.description}` };
  if (rmDanger) return { icon: "⚠️", description: `bash: ${displayCmd}\n   ⚠️  DANGEROUS: ${rmDanger.description}` };
  return { icon: "🔒", description: `bash: ${displayCmd}` };
}
