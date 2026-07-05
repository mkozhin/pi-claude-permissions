/**
 * Fork: Opinionated Permissions + Plan Mode for pi
 *
 * Based on zackify/pi-claude-permissions and inspired by rHedBull/pi-permissions,
 * trimmed down for this workflow:
 * - Shift+Tab cycles configurable modes.
 * - Default startup mode is confirmation mode (`default`) in this fork.
 * - Plan mode is read-only and injects planning instructions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// `@earendil-works/pi-tui` is a devDependency only (no runtime dependency entry) — this is
// not a packaging bug. Pi's extension loader aliases the `@earendil-works/pi-tui` specifier
// to its own bundled copy of pi-tui at runtime (both the jiti dev-mode alias map and the
// compiled-binary VIRTUAL_MODULES map resolve it), so this value import works correctly when
// the extension actually runs under `pi`, even though npm never installs pi-tui as a
// dependency of this package. Keep this devDependency's version pinned to match the host's
// bundled pi-tui version (see CLAUDE.md → Maintainer Workflow) so `Key`/`matchesKey` semantics
// used here stay identical to what the host's own components use at runtime.
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, KeyId } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

type PermissionMode = string;
type Pattern = { pattern: string; description: string };
type UiContext = {
  ui: any;
  hasUI?: boolean;
  // Run mode ("tui" | "rpc" | "json" | "print"); only "tui" implements ui.custom() as a real dialog.
  mode?: string;
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  cwd?: string;
};

interface SessionAllow {
  tools: Set<string>;
  commands: Set<string>;
}

interface CustomModePolicy {
  excludedTools?: string[];
  allowedWriteRoots?: Array<"cwd" | "parent" | string>;
  blockedBashPatterns?: Pattern[];
  network?: {
    allowLocalhostOnly?: boolean;
    allowGithubReadOnly?: boolean;
    allowedPorts?: number[];
  };
}

interface ModeDefinition {
  id: PermissionMode;
  label: string;
  description: string;
  status: string;
  policy?: CustomModePolicy;
}

interface ModeDisplay {
  icon: string;
  text: string;
  color: string;
  statusText: string;
}

interface PermissionsConfig {
  mode?: string;
  dangerousPatterns?: Pattern[];
  catastrophicPatterns?: Pattern[];
  protectedPaths?: string[];
  allowCatastrophic?: boolean;
  shiftTabOptions?: string[];
  defaultMode?: string;
  hideDefaultMode?: boolean;
  planModeAllowedMcpServers?: string[];
  customModes?: ModeDefinition[];
}

interface PiSettingsConfig {
  piClaudePermissions?: {
    allowCatastrophic?: boolean;
    shiftTabOptions?: string[];
    defaultMode?: string;
    hideDefaultMode?: boolean;
    planModeAllowedMcpServers?: string[];
    customModes?: ModeDefinition[];
  };
}

const DEFAULT_MODE: PermissionMode = "default";
const PLAN_BLOCK_REASON = "You are in plan mode, you can only read files/search tools until the user exits plan mode.";
const POWERBAR_SEGMENT_ID = "permissions";
const POWERBAR_SEGMENT_LABEL = "Permissions";

const BUILT_IN_MODES: ModeDefinition[] = [
  { id: "default", label: "Default", description: "Ask before write/edit/bash operations", status: "⏵" },
  { id: "plan", label: "Plan", description: "Read-only exploration; only read/search tools and safe bash", status: "⏸" },
  { id: "acceptEdits", label: "Accept Edits", description: "Allow write/edit silently, confirm bash", status: "⏵⏵" },
  { id: "bypassPermissions", label: "Bypass Permissions", description: "Allow everything except catastrophic/protected operations", status: "⏵⏵⏵⏵" },
  { id: "strict", label: "Strict", description: "Ask before almost every tool call", status: "⏵!" },
];

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "rg", "fd", "bat", "eza", "mcp"];
const GATED_TOOLS = new Set(["write", "edit", "bash"]);
const DEFAULT_ALWAYS_ALLOWED_TOOLS = new Set(["manage_todo_list", "ask_user"]);
const DEFAULT_READ_TOOLS = new Set(["read", "grep", "find", "ls", "rg", "fd", "bat", "eza"]);
const DIRECT_READ_PATH_INPUT_KEYS = new Set(["path", "paths", "file", "files", "glob"]);
const SENSITIVE_CREDENTIAL_PATH_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker"]);
const SENSITIVE_CREDENTIAL_FILES = new Set([".npmrc", ".netrc"]);
const SENSITIVE_FILE_STEMS = new Set(["credential", "credentials", "token", "tokens", "secret", "secrets", "auth", "id_rsa", "id_ed25519"]);
const SENSITIVE_GLOB_MATCH_SEGMENTS = [
  ".env", ".env.local", ".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker",
  ".npmrc", ".netrc", "credentials", "credentials.json", "token", "token.txt",
  "secret", "secret.json", "auth", "auth.json", "private-key.pem",
  "private_key.pem", "id_rsa", "id_ed25519",
];
const SEARCH_PATTERN_COMMANDS = new Set(["grep", "rg", "sed", "awk", "jq"]);
const CWD_DEFAULTING_BASH_COMMANDS = new Set(["ls", "eza", "tree", "du", "find", "fd", "rg"]);
const PATH_BEARING_BASH_OPTIONS = new Set([
  "-f", "-g",
  "--base-directory", "--exclude", "--exclude-dir", "--exclude-from", "--file", "--from-file",
  "--glob", "--iglob", "--ignore-file", "--include", "--search-path",
]);
const SHORT_PATH_BEARING_BASH_OPTIONS = new Set(["-f", "-g"]);
const GENERIC_PATH_BEARING_BASH_OPTIONS = new Set(["--from-file", "--to-file", "--files0-from"]);
const INDIRECT_FILE_LIST_OPTIONS = new Set(["--files0-from", "--files-from"]);
const NO_SHORT_PATH_BEARING_BASH_OPTIONS = new Set<string>();
const FD_SEARCH_ROOT_OPTIONS = new Set(["--base-directory", "--search-path"]);
const FILE_COMMAND_FILE_LIST_OPTIONS = new Set(["--files-from"]);
const FILE_COMMAND_SHORT_FILE_LIST_OPTIONS = new Set(["-f"]);
const FIND_FILE_LIST_OPTIONS = new Set(["-files0-from"]);
const GIT_FILE_CONSUMING_OPTIONS = new Set(["--exclude-from", "--exclude-per-directory", "--pathspec-from-file"]);
const PATTERN_BEARING_BASH_OPTIONS = new Set(["-e", "--regexp", "--pattern", "--fixed-strings"]);
const SHORT_PATTERN_BEARING_BASH_OPTIONS = new Set(["-e"]);
const FIND_PREFIX_OPTIONS_WITH_VALUE = new Set(["-D"]);
const FIND_PREFIX_OPTIONS = new Set(["-H", "-L", "-P"]);
const FIND_PATH_PREDICATES = new Set([
  "-name", "-iname", "-lname", "-ilname", "-path", "-ipath",
  "-wholename", "-iwholename", "-regex", "-iregex",
]);
const GIT_PATH_BEARING_OPTIONS = new Set(["-C", "--git-dir", "--work-tree"]);
const GIT_VALUE_OPTIONS = new Set(["-c", "--config-env"]);
const GIT_CONFIG_PATH_OPTIONS = new Set(["-f", "--file"]);
const FD_OPTIONS_WITH_VALUE = new Set([
  "-d", "-E", "-e", "-j", "-t",
  "--and", "--base-directory", "--changed-before", "--changed-within", "--color",
  "--exclude", "--extension", "--format", "--glob", "--hyperlink-format",
  "--ignore-file", "--max-depth", "--min-depth", "--owner", "--path-separator",
  "--search-path", "--threads", "--type",
]);
const DEFAULT_SAFE_BASH_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "find", "ls",
  "pwd", "wc", "sort", "uniq", "diff", "file", "stat", "du", "df",
  "which", "whereis", "type", "echo", "printf", "jq", "fd",
  "bat", "eza",
]);

const SAFE_PLAN_BASH_PREFIXES = [
  "cat", "head", "tail", "less", "more", "grep", "find", "ls",
  "pwd", "echo", "printf", "wc", "sort", "uniq", "diff", "file",
  "stat", "du", "df", "tree", "which", "whereis", "type",
  "uname", "whoami", "id", "date", "cal", "uptime",
  "ps", "top", "htop", "free", "jq",
  "rg", "fd", "bat", "eza", "git status", "git log", "git diff",
  "git show", "git branch", "git remote", "git ls-", "git config --get",
  "gh pr view", "gh pr list", "gh pr diff", "gh pr checks", "gh pr status",
  "gh issue view", "gh issue list", "gh issue status", "gh repo view",
  "gh run view", "gh run list", "gh release view", "gh release list",
  "gh auth status", "npm list", "npm ls", "npm view",
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

const PLAN_MODE_MESSAGE = `[PLAN MODE]
Read/search only. Do not edit files, write files, or run mutating commands.

Inspect what you need, then give the user a clear plan with the files and changes involved. Wait for the user to toggle out of plan mode before executing.`;

const PLAN_MODE_ENDED_MESSAGE = `[PLAN MODE ENDED]
The user toggled out of plan mode. You may now execute the plan using the active permission mode.`;

export default async function permissionExtension(pi: ExtensionAPI) {
  pi.registerFlag("permission-mode", {
    description: "Permission mode (default, plan, acceptEdits, bypassPermissions, strict)",
    type: "string",
    default: "",
  });
  pi.registerFlag("dangerously-skip-permissions", {
    description: "Bypass all permission checks except catastrophic/protected checks",
    type: "boolean",
    default: false,
  });

  registerPowerbarSegment(pi);

  const config = await loadConfig();
  const home = homedir();
  const sessionAllow: SessionAllow = { tools: new Set(), commands: new Set() };
  const dangerousPatterns = config.dangerousPatterns ?? DEFAULT_DANGEROUS;
  const catastrophicPatterns = config.catastrophicPatterns ?? DEFAULT_CATASTROPHIC;
  const protectedPaths = (config.protectedPaths ?? DEFAULT_PROTECTED_PATHS).map((path) => resolveConfiguredPath(path, home));
  const allowCatastrophic = config.allowCatastrophic === true;
  const modes = buildModeDefinitions(config.customModes);
  const defaultMode = normalizeMode(config.defaultMode, DEFAULT_MODE, modes);
  const hideDefaultMode = config.hideDefaultMode === true;
  const planModeAllowedMcpServers = new Set(config.planModeAllowedMcpServers ?? []);
  const shiftTabModes = normalizeShiftTabOptions(config.shiftTabOptions, modes);

  let mode = normalizeMode(config.mode, defaultMode, modes);
  let previousActiveTools: string[] | null = null;
  let planContextPending = mode === "plan";
  let planTurnObserved = false;
  let planEndedContextPending = false;

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

  const applyMode = async (nextMode: PermissionMode, ctx: UiContext) => {
    const wasPlan = mode === "plan";
    const enteringPlan = nextMode === "plan" && !wasPlan;
    const leavingPlan = wasPlan && nextMode !== "plan";

    mode = nextMode;
    clearSessionAllows();

    if (enteringPlan || nextMode === "plan") {
      enterPlanToolScope();
      planContextPending = true;
      if (enteringPlan) planTurnObserved = false;
      planEndedContextPending = false;
      ctx.ui.notify("In plan mode, only read files/search tools are allowed.", "info");
    } else {
      if (leavingPlan) {
        restoreToolsAfterPlan();
        planContextPending = false;
        planEndedContextPending = planTurnObserved;
        planTurnObserved = false;
        ctx.ui.notify("Plan mode ended", "info");
      }
      ctx.ui.notify(`Permission mode: ${getModeMeta(mode, modes).label}`, "info");
    }

    updateModeDisplay(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    clearSessionAllows();

    if (pi.getFlag("dangerously-skip-permissions") === true) {
      mode = "bypassPermissions";
    } else {
      const flagMode = pi.getFlag("permission-mode");
      if (typeof flagMode === "string" && flagMode) mode = normalizeMode(flagMode, defaultMode, modes);
    }

    if (mode === "plan") {
      enterPlanToolScope();
      planContextPending = true;
    } else {
      restoreToolsAfterPlan();
      planContextPending = false;
    }
    planTurnObserved = false;
    planEndedContextPending = false;

    registerPowerbarSegment(pi);
    updateModeDisplay(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearPowerbarSegment(pi);
  });

  pi.registerShortcut("shift+tab", {
    description: `Cycle permission mode (${shiftTabModes.map((m) => getModeMeta(m, modes).label).join(" → ")})`,
    handler: async (ctx) => {
      const idx = shiftTabModes.findIndex((m) => m === mode);
      await applyMode(shiftTabModes[(idx + 1) % shiftTabModes.length]!, ctx);
    },
  });

  pi.registerCommand("permissions", {
    description: "Select permission mode",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/permissions requires interactive UI", "warning");
        return;
      }

      const options = modes.map((m) => `${m.label} — ${m.description}`);
      const selected = await ctx.ui.select("Select permission mode", options);
      const idx = selected ? options.indexOf(selected) : -1;
      if (idx >= 0) await applyMode(modes[idx]!.id, ctx);
    },
  });

  pi.on("before_agent_start", async () => {
    if (mode === "plan" && planContextPending) {
      planContextPending = false;
      planTurnObserved = true;
      return {
        message: {
          customType: "plan-mode-context",
          content: PLAN_MODE_MESSAGE,
          display: true,
        },
      };
    }

    if (mode !== "plan" && planEndedContextPending) {
      planEndedContextPending = false;
      return {
        message: {
          customType: "plan-mode-ended-context",
          content: PLAN_MODE_ENDED_MESSAGE,
          display: true,
        },
      };
    }

    const modeMeta = getModeMeta(mode, modes);
    if (!modeMeta.policy || !modeMeta.description) return;
    return {
      message: {
        customType: "permission-mode-context",
        content: `[${modeMeta.label.toUpperCase()} MODE ACTIVE]\n${modeMeta.description}`,
        display: true,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    const safetyBlock = await enforceAlwaysOnSafety({
      toolName,
      input: event.input,
      ctx,
      mode,
      home,
      protectedPaths,
      catastrophicPatterns,
      allowCatastrophic,
    });
    if (safetyBlock) return safetyBlock;

    if (mode === "plan") return enforcePlanMode(toolName, event.input, planModeAllowedMcpServers);
    const modeMeta = getModeMeta(mode, modes);
    const customPolicy = modeMeta.policy;
    if (!customPolicy && mode !== "default" && mode !== "strict" && !GATED_TOOLS.has(toolName)) return;

    if (customPolicy) return enforceCustomMode(toolName, event.input, ctx, customPolicy);
    if (mode === "bypassPermissions") return;
    if (mode === "acceptEdits" && (toolName === "write" || toolName === "edit")) return;

    if (isSessionAllowed(toolName, event.input, sessionAllow)) return;

    if (mode === "default" && (
      DEFAULT_ALWAYS_ALLOWED_TOOLS.has(toolName)
      || isDefaultAllowedReadTool(toolName, event.input, ctx, home, protectedPaths)
    )) return;

    if (!ctx.hasUI) {
      return { block: true as const, reason: `Blocked ${toolName} (no UI for confirmation, mode: ${mode})` };
    }

    return promptApproval(toolName, event.input, ctx, dangerousPatterns, catastrophicPatterns, sessionAllow, allowCatastrophic);
  });
}

async function loadConfig(): Promise<PermissionsConfig> {
  const globalPath = resolve(homedir(), ".pi/agent/extensions/permissions.json");
  const localPath = resolve(process.cwd(), ".pi/extensions/permissions.json");
  const globalSettingsPath = resolve(homedir(), ".pi/agent/settings.json");
  const localSettingsPath = resolve(process.cwd(), ".pi/settings.json");
  const global = await readJson<PermissionsConfig>(globalPath);
  const local = await readJson<PermissionsConfig>(localPath);
  const globalSettings = await readJson<PiSettingsConfig>(globalSettingsPath);
  const localSettings = await readJson<PiSettingsConfig>(localSettingsPath);

  return {
    mode: stringOrUndefined(local.mode ?? global.mode),
    dangerousPatterns: local.dangerousPatterns ?? global.dangerousPatterns ?? DEFAULT_DANGEROUS,
    catastrophicPatterns: local.catastrophicPatterns ?? global.catastrophicPatterns ?? DEFAULT_CATASTROPHIC,
    protectedPaths: local.protectedPaths ?? global.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    allowCatastrophic: localSettings.piClaudePermissions?.allowCatastrophic
      ?? globalSettings.piClaudePermissions?.allowCatastrophic
      ?? local.allowCatastrophic
      ?? global.allowCatastrophic
      ?? false,
    shiftTabOptions: localSettings.piClaudePermissions?.shiftTabOptions
      ?? globalSettings.piClaudePermissions?.shiftTabOptions
      ?? local.shiftTabOptions
      ?? global.shiftTabOptions,
    defaultMode: stringOrUndefined(localSettings.piClaudePermissions?.defaultMode
      ?? globalSettings.piClaudePermissions?.defaultMode
      ?? local.defaultMode
      ?? global.defaultMode),
    hideDefaultMode: localSettings.piClaudePermissions?.hideDefaultMode
      ?? globalSettings.piClaudePermissions?.hideDefaultMode
      ?? local.hideDefaultMode
      ?? global.hideDefaultMode,
    planModeAllowedMcpServers: stringArrayOrUndefined(localSettings.piClaudePermissions?.planModeAllowedMcpServers)
      ?? stringArrayOrUndefined(globalSettings.piClaudePermissions?.planModeAllowedMcpServers)
      ?? stringArrayOrUndefined(local.planModeAllowedMcpServers)
      ?? stringArrayOrUndefined(global.planModeAllowedMcpServers),
    customModes: localSettings.piClaudePermissions?.customModes
      ?? globalSettings.piClaudePermissions?.customModes
      ?? local.customModes
      ?? global.customModes,
  };
}

async function readJson<T>(path: string): Promise<T | Record<string, never>> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function buildModeDefinitions(customModes: unknown): ModeDefinition[] {
  const modes = [...BUILT_IN_MODES];
  if (!Array.isArray(customModes)) return modes;

  for (const customMode of customModes) {
    const mode = normalizeCustomMode(customMode);
    if (!mode) continue;
    const existing = modes.findIndex((candidate) => candidate.id === mode.id);
    if (existing >= 0) modes[existing] = mode;
    else modes.push(mode);
  }

  return modes;
}

function normalizeCustomMode(value: unknown): ModeDefinition | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, any>;
  const id = stringOrUndefined(raw.id);
  const label = stringOrUndefined(raw.label);
  if (!id || !label) return;

  return {
    id,
    label,
    description: stringOrUndefined(raw.description) ?? label,
    status: stringOrUndefined(raw.status) ?? "⏵",
    policy: normalizeCustomModePolicy(raw.policy ?? raw),
  };
}

function normalizeCustomModePolicy(raw: Record<string, any>): CustomModePolicy | undefined {
  const policy: CustomModePolicy = {};
  if (Array.isArray(raw.excludedTools)) policy.excludedTools = raw.excludedTools.filter((tool: unknown): tool is string => typeof tool === "string");
  if (Array.isArray(raw.allowedWriteRoots)) policy.allowedWriteRoots = raw.allowedWriteRoots.filter((root: unknown): root is string => typeof root === "string");
  if (Array.isArray(raw.blockedBashPatterns)) {
    policy.blockedBashPatterns = raw.blockedBashPatterns
      .filter((pattern: unknown): pattern is Pattern => Boolean(pattern) && typeof pattern === "object" && typeof (pattern as Pattern).pattern === "string")
      .map((pattern: Pattern) => ({ pattern: pattern.pattern, description: pattern.description ?? pattern.pattern }));
  }
  if (raw.network && typeof raw.network === "object") {
    policy.network = {
      allowLocalhostOnly: raw.network.allowLocalhostOnly === true,
      allowGithubReadOnly: raw.network.allowGithubReadOnly === true,
      allowedPorts: Array.isArray(raw.network.allowedPorts)
        ? raw.network.allowedPorts.filter((port: unknown): port is number => Number.isInteger(port))
        : undefined,
    };
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function normalizeMode(mode: unknown, fallback: PermissionMode = DEFAULT_MODE, modes: ModeDefinition[] = BUILT_IN_MODES): PermissionMode {
  return parseMode(mode, modes) ?? fallback;
}

function parseMode(mode: unknown, modes: ModeDefinition[]): PermissionMode | undefined {
  if (typeof mode !== "string") return;
  if (modes.some((candidate) => candidate.id === mode)) return mode;
}

function normalizeShiftTabOptions(options: unknown, allModes: ModeDefinition[]): PermissionMode[] {
  if (!Array.isArray(options)) return allModes.map((mode) => mode.id);

  const modes = options
    .map((option) => parseMode(option, allModes))
    .filter((mode): mode is PermissionMode => mode !== undefined)
    .filter((mode, index, all) => all.indexOf(mode) === index);
  return modes.length > 0 ? modes : allModes.map((mode) => mode.id);
}

function getModeMeta(mode: PermissionMode, modes: ModeDefinition[]) {
  return modes.find((m) => m.id === mode) ?? modes.find((m) => m.id === DEFAULT_MODE)!;
}

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

function enforcePlanMode(toolName: string, input: Record<string, unknown>, allowedMcpServers: Set<string>) {
  if (!PLAN_MODE_TOOLS.includes(toolName)) return { block: true as const, reason: PLAN_BLOCK_REASON };
  if (toolName === "bash" && !isSafePlanCommand(String(input.command ?? ""))) {
    return { block: true as const, reason: PLAN_BLOCK_REASON };
  }
  if (toolName === "mcp" && !isAllowedPlanModeMcpCall(input, allowedMcpServers)) {
    return { block: true as const, reason: "MCP is only allowed in plan mode for servers listed in piClaudePermissions.planModeAllowedMcpServers." };
  }
}

function isAllowedPlanModeMcpCall(input: Record<string, unknown>, allowedMcpServers: Set<string>): boolean {
  const server = stringOrUndefined(input.server ?? input.connect);
  return Boolean(server && allowedMcpServers.has(server));
}

function enforceCustomMode(toolName: string, input: Record<string, unknown>, ctx: UiContext, policy: CustomModePolicy) {
  if (policy.excludedTools?.includes(toolName)) {
    return { block: true as const, reason: `${toolName} is blocked in this permission mode.` };
  }

  if (toolName === "write" || toolName === "edit") {
    const targetPath = resolveReadPath(String(input.path ?? ""), ctx, homedir());
    if (!isPathInAllowedRoots(targetPath, ctx, policy.allowedWriteRoots)) {
      return { block: true as const, reason: `Write blocked outside allowed roots: ${targetPath}` };
    }
  }

  if (toolName === "bash") {
    const command = String(input.command ?? "");
    const blockedPattern = findCommandPatternMatch(command, policy.blockedBashPatterns ?? []);
    if (blockedPattern) {
      return { block: true as const, reason: blockedPattern.description };
    }

    const pathBlock = findBashPathBlock(command, ctx, policy.allowedWriteRoots);
    if (pathBlock) return { block: true as const, reason: pathBlock };

    const networkBlock = findNetworkBlock(command, policy.network);
    if (networkBlock) return { block: true as const, reason: networkBlock };
  }
}

function isPathInAllowedRoots(targetPath: string, ctx: UiContext, roots: CustomModePolicy["allowedWriteRoots"]): boolean {
  if (!roots || roots.length === 0) return true;
  return getAllowedRoots(ctx, roots).some((root) => targetPath === root || targetPath.startsWith(root + "/"));
}

function getAllowedRoots(ctx: UiContext, roots: CustomModePolicy["allowedWriteRoots"]): string[] {
  const cwd = resolve(ctx.cwd ?? process.cwd());
  return (roots ?? []).map((root) => {
    if (root === "cwd") return cwd;
    if (root === "parent") return resolve(cwd, "..");
    if (root.startsWith("~/")) return resolve(homedir(), root.slice(2));
    return resolve(root);
  });
}

function findBashPathBlock(command: string, ctx: UiContext, roots: CustomModePolicy["allowedWriteRoots"]): string | undefined {
  if (!roots || roots.length === 0) return;
  const allowedRoots = getAllowedRoots(ctx, roots);
  const cwd = resolve(ctx.cwd ?? process.cwd());
  const pathPattern = /(?:^|\s)(~\/?[^\s;&|]*|\.\.?\/?[^\s;&|]*|\/[^\s;&|]*)/g;
  for (const match of command.matchAll(pathPattern)) {
    const token = match[1]?.replace(/["']+$/g, "");
    if (!token || token === "." || token === ".." || token.startsWith("/-")) continue;
    if (token.startsWith("/dev/")) continue;

    const resolved = token.startsWith("~/") || token === "~"
      ? resolve(homedir(), token === "~" ? "" : token.slice(2))
      : token.startsWith("/")
        ? resolve(token)
        : resolve(cwd, token);

    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + "/"))) {
      return `Bash path blocked outside allowed roots: ${token}`;
    }
  }
}

function findCommandPatternMatch(command: string, patterns: Pattern[]): Pattern | undefined {
  return patterns.find((pattern) => {
    try {
      return new RegExp(pattern.pattern).test(command);
    } catch {
      return command.includes(pattern.pattern);
    }
  });
}

function findNetworkBlock(command: string, network: CustomModePolicy["network"]): string | undefined {
  if (!network?.allowLocalhostOnly) return;

  const urls = extractUrls(command);
  for (const url of urls) {
    if (!isAllowedLocalUrl(url, network.allowedPorts) && !isAllowedGithubReadUrl(url, network.allowGithubReadOnly)) {
      return `Network request blocked outside allowed localhost ports/GitHub read-only access: ${url}`;
    }
  }

  if (isAllowedGithubReadCommand(command, network.allowGithubReadOnly)) return;
  if (hasExternalNetworkIntent(command)) return "Network command blocked unless it targets localhost or a read-only GitHub operation.";
  if (!isNetworkCommand(command)) return;
  const localRefs = extractLocalhostRefs(command);
  if (localRefs.length === 0) return "Network command blocked unless it targets an allowed localhost port.";
  for (const ref of localRefs) {
    if (!isAllowedLocalPort(ref.port, network.allowedPorts)) {
      return `Network request blocked outside allowed localhost ports: ${ref.raw}`;
    }
  }
}

function extractUrls(command: string): string[] {
  return Array.from(command.matchAll(/https?:\/\/[^\s'"`<>]+/gi), (match) => match[0]);
}

function extractLocalhostRefs(command: string): Array<{ raw: string; port?: number }> {
  return Array.from(command.matchAll(/\b(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::(\d+))?\b/gi), (match) => ({
    raw: match[0],
    port: match[1] ? Number(match[1]) : undefined,
  }));
}

function isNetworkCommand(command: string): boolean {
  return /\b(curl|wget|http|httpie|nc|netcat|telnet|ssh|scp|rsync|gh\s+api)\b/i.test(command)
    || /\b(?:node|python|python3|ruby|perl|php|deno|bun)\b[^|;&]*(?:fetch|request|requests|urllib|http|https|socket|net\.)/i.test(command)
    || /\b(npm|pnpm|yarn|bun)\s+(install|add|view|info|search|audit|outdated|publish)\b/i.test(command)
    || /\bpip\s+install\b/i.test(command);
}

function hasExternalNetworkIntent(command: string): boolean {
  return /\b(?:ssh|scp|rsync)\s+(?!.*(?:localhost|127\.0\.0\.1|\[?::1\]?))/i.test(command)
    || /\b(?:git\s+(?:clone|fetch|pull|ls-remote)|gh\s+|npm\s+|pnpm\s+|yarn\s+|bun\s+|pip\s+)/i.test(command);
}

function isAllowedGithubReadCommand(command: string, allowGithubReadOnly?: boolean): boolean {
  if (!allowGithubReadOnly) return false;
  const trimmed = command.trim();
  return /\bgh\s+pr\s+(view|list|diff|checks|status)\b/i.test(trimmed)
    || /\bgh\s+issue\s+(view|list|status)\b/i.test(trimmed)
    || /\bgh\s+repo\s+view\b/i.test(trimmed)
    || /\bgh\s+run\s+(view|list)\b/i.test(trimmed)
    || /\bgh\s+release\s+(view|list)\b/i.test(trimmed)
    || /\bgh\s+api\b[^|;&]*\b-X\s+GET\b/i.test(trimmed)
    || /\bgit\s+(?:fetch|pull|ls-remote)\b[^|;&]*(?:github\.com[:/]|https:\/\/github\.com\/)/i.test(trimmed);
}

function isAllowedLocalUrl(rawUrl: string, allowedPorts?: number[]): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") return false;
    const port = url.port ? Number(url.port) : undefined;
    return isAllowedLocalPort(port, allowedPorts);
  } catch {
    return false;
  }
}

function isAllowedGithubReadUrl(rawUrl: string, allowGithubReadOnly?: boolean): boolean {
  if (!allowGithubReadOnly) return false;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".github.com") || host === "api.github.com";
  } catch {
    return false;
  }
}

function isAllowedLocalPort(port: number | undefined, allowedPorts?: number[]): boolean {
  if (!allowedPorts || allowedPorts.length === 0) return true;
  return port !== undefined && allowedPorts.includes(port);
}

async function enforceAlwaysOnSafety(args: {
  toolName: string;
  input: Record<string, unknown>;
  ctx: UiContext;
  mode: PermissionMode;
  home: string;
  protectedPaths: string[];
  catastrophicPatterns: Pattern[];
  allowCatastrophic: boolean;
}) {
  const { toolName, input, ctx, mode, home, protectedPaths, catastrophicPatterns, allowCatastrophic } = args;

  if (toolName === "bash") {
    const command = String(input.command ?? "");

    if (!allowCatastrophic) {
      const criticalRm = checkCriticalRmRf(command, ctx.cwd ?? process.cwd());
      if (criticalRm) {
        ctx.ui.notify(`🚫 Blocked catastrophic command: ${criticalRm}`, "error");
        return { block: true as const, reason: `Catastrophic command blocked: ${criticalRm}. This cannot be overridden.` };
      }

      const catastrophe = findBuiltinCatastrophicBashCommand(command) ?? findMatch(command, catastrophicPatterns);
      if (catastrophe) {
        ctx.ui.notify(`🚫 Blocked catastrophic command: ${catastrophe.description}`, "error");
        return { block: true as const, reason: `Catastrophic command blocked: ${catastrophe.description}. This cannot be overridden.` };
      }
    }

    const protectedPath = findProtectedBashPath(command, ctx, home, protectedPaths);
    if (protectedPath) {
      const readable = protectedPath.replace(home, "~");
      ctx.ui.notify(`🚫 Blocked bash targeting protected path: ${readable}`, "error");
      return { block: true as const, reason: `Bash command references protected path ${readable}. This cannot be overridden.` };
    }

    if (shouldHardBlockProtectedBashTraversal(mode)) {
      const protectedTraversalPath = findProtectedBashTraversalCommandPath(command, ctx, home, protectedPaths);
      if (protectedTraversalPath) {
        const readable = protectedTraversalPath.replace(home, "~");
        ctx.ui.notify(`🚫 Blocked bash traversing protected path: ${readable}`, "error");
        return { block: true as const, reason: `Bash command may traverse protected path ${readable}. This cannot be overridden.` };
      }
    }
  }

  if (toolName === "write" || toolName === "edit") {
    const targetPath = resolveReadPath(String(input.path ?? ""), ctx, home);
    const protectedPath = findProtectedPathForResolvedPath(targetPath, protectedPaths);
    if (protectedPath) {
      ctx.ui.notify(`🚫 Blocked write to protected path: ${targetPath}`, "error");
      return { block: true as const, reason: `Protected path blocked: ${targetPath}. This cannot be overridden.` };
    }
  }
}

function shouldHardBlockProtectedBashTraversal(mode: PermissionMode): boolean {
  return mode !== "default" && mode !== "strict";
}

function isSessionAllowed(toolName: string, input: Record<string, unknown>, sessionAllow: SessionAllow): boolean {
  if (toolName === "bash" && sessionAllow.commands.has(String(input.command ?? ""))) return true;
  return sessionAllow.tools.has(toolName);
}

function findProtectedBashPath(command: string, ctx: UiContext, home: string, protectedPaths: string[]): string | undefined {
  for (const segment of splitShellCommandSegments(command)) {
    for (const candidate of getBashPathCandidates(segment, home)) {
      const protectedPath = findProtectedPathForInput(candidate, ctx, home, protectedPaths);
      if (protectedPath) return protectedPath;
    }
  }

  if (hasRuntimePathConstructionSyntax(command)) {
    const normalizedCommand = normalizeShellPathText(command, home);
    return findProtectedPathInCompactedShellText(normalizedCommand, ctx, home, protectedPaths)
      ?? findProtectedPathInDynamicShellText(command, normalizedCommand, ctx, home, protectedPaths);
  }
}

function findProtectedBashTraversalCommandPath(command: string, ctx: UiContext, home: string, protectedPaths: string[]): string | undefined {
  for (const segment of splitShellCommandSegments(command)) {
    const protectedPath = findProtectedBashTraversalPath(segment, ctx, home, protectedPaths);
    if (protectedPath) return protectedPath;
  }
}

function findProtectedBashTraversalPath(segment: string, ctx: UiContext, home: string, protectedPaths: string[]): string | undefined {
  const tokens = getNormalizedShellTokens(segment, home);
  const commandIndex = tokens.findIndex((token) => !isShellAssignment(token));
  if (commandIndex < 0) return;

  const commandName = getCommandName(tokens[commandIndex]!);
  const args = tokens.slice(commandIndex + 1);
  const roots = getBashTraversalRoots(commandName, args);
  for (const root of roots) {
    const protectedPath = findProtectedPathContainedByRoot(root, ctx, home, protectedPaths);
    if (protectedPath) return protectedPath;
  }
}

function getBashTraversalRoots(commandName: string, args: string[]): string[] {
  if (commandName === "find") {
    const roots = getFindSearchRoots(args);
    return roots.length > 0 ? roots : ["."];
  }

  if (commandName === "fd") {
    const positional = getFdPositionalArgs(args);
    const roots = getFdSearchRoots(args, positional);
    if (roots.length > 0) return roots;
    return positional.length < 2 ? ["."] : [];
  }

  if (commandName === "grep") {
    if (!isRecursiveGrepArgs(args)) return [];
    const roots = getPatternThenPathCandidates(args);
    return roots.length > 0 ? roots : ["."];
  }

  if (commandName === "rg") {
    const roots = hasOption(args, "--files") ? getAllPositionalPathCandidates(args) : getPatternThenPathCandidates(args);
    return roots.length > 0 ? roots : ["."];
  }

  if (commandName === "ls" || commandName === "eza") {
    if (!isRecursiveListArgs(args)) return [];
    const roots = getPositionalArgs(args);
    return roots.length > 0 ? roots : ["."];
  }

  if (commandName === "tree") {
    const roots = getPositionalArgs(args);
    return roots.length > 0 ? roots : ["."];
  }

  return [];
}

function isRecursiveGrepArgs(args: string[]): boolean {
  return hasShortFlag(args, "R") || hasShortFlag(args, "r")
    || hasOption(args, "--recursive")
    || hasOption(args, "--dereference-recursive")
    || hasGrepRecursiveDirectoryOption(args);
}

function isRecursiveListArgs(args: string[]): boolean {
  return hasShortFlag(args, "R") || hasOption(args, "--recursive") || hasOption(args, "--recurse");
}

function hasRuntimePathConstructionSyntax(command: string): boolean {
  return /[`]|\$\(|<\(|>\(/.test(command)
    || /\b(?:eval|source)\b/i.test(command)
    || /\b(?:python|python3|node|ruby|perl|php|deno|bun|sh|bash|zsh|fish)\s+-(?:c|e|r)\b/i.test(command);
}

function findProtectedPathInCompactedShellText(command: string, ctx: UiContext, home: string, protectedPaths: string[]): string | undefined {
  const compactCommand = compactPathConstructionText(command);

  return protectedPaths.find((path) => {
    const normalizedPath = resolve(path);
    return getProtectedPathTextVariants(normalizedPath, ctx, home).some((variant) =>
      compactCommand.includes(compactPathConstructionText(variant)),
    );
  });
}

function findProtectedPathInDynamicShellText(command: string, normalizedCommand: string, ctx: UiContext, home: string, protectedPaths: string[]): string | undefined {
  if (!hasHomeReferenceInShellText(command, normalizedCommand, home)) return;
  const compactCommand = compactPathConstructionText(normalizedCommand).toLowerCase();
  const normalizedHome = resolve(home);

  return protectedPaths.find((path) => {
    const normalizedPath = resolve(path);
    if (normalizedPath !== normalizedHome && !normalizedPath.startsWith(`${normalizedHome}/`)) return false;

    const homeRelative = normalizedPath === normalizedHome ? "" : normalizedPath.slice(normalizedHome.length + 1);
    if (!homeRelative) return true;

    const compactRelative = compactPathConstructionText(homeRelative).toLowerCase();
    if (compactRelative && compactCommand.includes(compactRelative)) return true;

    const segments = splitPathSegments(homeRelative)
      .map((segment) => compactPathConstructionText(segment).toLowerCase())
      .filter((segment) => segment.length > 0);
    return segments.length > 0 && segments.every((segment) => compactCommand.includes(segment));
  });
}

function hasHomeReferenceInShellText(command: string, normalizedCommand: string, home: string): boolean {
  const compactCommand = compactPathConstructionText(normalizedCommand).toLowerCase();
  const compactHome = compactPathConstructionText(resolve(home)).toLowerCase();
  return compactCommand.includes(compactHome)
    || /(?:\bHOME\b|\bhomedir\b|\bhomeDir\b|expanduser|Path\.home|user\.home)/.test(command)
    || /~/.test(command);
}

function getProtectedPathTextVariants(protectedPath: string, ctx: UiContext, home: string): string[] {
  const variants = [protectedPath];
  const normalizedHome = resolve(home);
  const cwd = resolve(ctx.cwd ?? process.cwd());

  if (protectedPath === normalizedHome || protectedPath.startsWith(`${normalizedHome}/`)) {
    const homeRelative = protectedPath === normalizedHome ? "" : protectedPath.slice(normalizedHome.length + 1);
    variants.push(homeRelative ? `~/${homeRelative}` : "~");
  }

  if (protectedPath === cwd || protectedPath.startsWith(`${cwd}/`)) {
    const cwdRelative = protectedPath === cwd ? "." : relative(cwd, protectedPath);
    variants.push(cwdRelative, `./${cwdRelative}`);
  }

  return uniqueStrings(variants);
}

function compactPathConstructionText(value: string): string {
  return value.replace(/[\s"'`+()[\]{},]/g, "");
}

function splitShellCommandSegments(command: string): string[] {
  return command.replace(/[<>]/g, " ").split(/[|;&\r\n]/);
}

function findProtectedPathForInput(rawPath: string, ctx: UiContext, home: string, protectedPaths: string[]): string | undefined {
  for (const path of getPathReferenceVariants(rawPath)) {
    const resolvedPath = resolveReadPath(path, ctx, home);
    const protectedPath = findProtectedPathForResolvedPath(resolvedPath, protectedPaths)
      ?? findProtectedPathForGlobPattern(resolvedPath, protectedPaths);
    if (protectedPath) return protectedPath;
  }
}

function findProtectedPathForResolvedPath(targetPath: string, protectedPaths: string[]): string | undefined {
  const normalizedTarget = resolve(targetPath);
  return protectedPaths.find((path) => {
    const normalizedPath = resolve(path);
    if (normalizedTarget === normalizedPath) return true;
    if (normalizedPath === "/") return normalizedTarget.startsWith("/");
    return normalizedTarget.startsWith(`${normalizedPath}/`);
  });
}

function findProtectedPathForGlobPattern(targetPath: string, protectedPaths: string[]): string | undefined {
  if (!hasGlobSyntax(targetPath)) return;
  return protectedPaths.find((path) => pathPatternMayReferencePath(targetPath, path));
}

function isDefaultAllowedReadTool(toolName: string, input: Record<string, unknown>, ctx: UiContext, home: string, protectedPaths: string[]): boolean {
  if (toolName === "bash") {
    return findSensitiveBashReadPath(String(input.command ?? ""), ctx, home) === undefined
      && findProtectedBashTraversalCommandPath(String(input.command ?? ""), ctx, home, protectedPaths) === undefined
      && isSafeDefaultReadCommand(String(input.command ?? ""), ctx, home);
  }
  if (!DEFAULT_READ_TOOLS.has(toolName)) return false;
  if (requiresExplicitDirectReadPath(toolName) && getDirectReadPathInputs(input).length === 0) return false;
  return !hasSensitiveDirectReadPath(toolName, input, ctx, home)
    && !hasProtectedDirectReadPath(toolName, input, ctx, home, protectedPaths);
}

function requiresExplicitDirectReadPath(toolName: string): boolean {
  return toolName === "read" || toolName === "bat";
}

function hasSensitiveDirectReadPath(toolName: string, input: Record<string, unknown>, ctx: UiContext, home: string): boolean {
  const paths = getDirectReadPathInputs(input);

  for (const path of paths) {
    if (isSensitiveReadPath(path, ctx, home)) return true;
  }

  if (paths.length === 0 && isSensitiveReadPath(ctx.cwd ?? process.cwd(), ctx, home)) return true;

  for (const path of getDirectReadNamePatternInputs(toolName, input)) {
    if (isSensitiveReadPath(path, ctx, home)) return true;
  }

  if (hasPotentialSensitiveDirectTraversal(toolName, input, ctx, home)) return true;

  return false;
}

function hasProtectedDirectReadPath(toolName: string, input: Record<string, unknown>, ctx: UiContext, home: string, protectedPaths: string[]): boolean {
  const paths = getDirectReadPathInputs(input);

  for (const path of paths) {
    if (findProtectedPathForInput(path, ctx, home, protectedPaths)) return true;
  }

  if (paths.length === 0 && findProtectedPathForInput(ctx.cwd ?? process.cwd(), ctx, home, protectedPaths)) return true;

  for (const path of getDirectReadNamePatternInputs(toolName, input)) {
    if (findProtectedPathForInput(path, ctx, home, protectedPaths)) return true;
  }

  if (directReadToolMayTraverse(toolName)) {
    for (const root of getDirectTraversalRoots(toolName, input)) {
      if (findProtectedPathContainedByRoot(root, ctx, home, protectedPaths)) return true;
    }
  }

  return false;
}

function directReadToolMayTraverse(toolName: string): boolean {
  return toolName === "grep" || toolName === "rg" || toolName === "find" || toolName === "fd";
}

function getDirectTraversalRoots(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === "find" || toolName === "fd") return getDirectSearchRoots(input);
  if (toolName !== "grep" && toolName !== "rg") return [];

  const paths: string[] = [];
  for (const key of ["path", "paths", "file", "files"]) collectStringValues(input[key], paths);
  return paths.length > 0 ? paths : ["."];
}

function findProtectedPathContainedByRoot(rawRoot: string, ctx: UiContext, home: string, protectedPaths: string[]): string | undefined {
  const resolvedRoot = resolveReadPath(normalizeShellPathText(rawRoot, home), ctx, home);
  const normalizedRoot = resolve(resolvedRoot);

  return protectedPaths.find((path) => {
    const normalizedPath = resolve(path);
    if (hasGlobSyntax(normalizedRoot)) return pathPatternMayReferencePath(normalizedRoot, normalizedPath);
    if (normalizedRoot === normalizedPath) return true;
    if (normalizedRoot === "/") return normalizedPath.startsWith("/");
    return normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

function getDirectReadPathInputs(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of DIRECT_READ_PATH_INPUT_KEYS) collectStringValues(input[key], paths);
  return paths;
}

function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === "string" && value.trim().length > 0) {
    output.push(value.trim());
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
  }
}

function getDirectReadNamePatternInputs(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName !== "find" && toolName !== "fd" && toolName !== "ls" && toolName !== "eza") return [];
  const patterns: string[] = [];
  collectStringValues(input.pattern, patterns);
  collectStringValues(input.name, patterns);
  return patterns;
}

function hasPotentialSensitiveDirectTraversal(toolName: string, input: Record<string, unknown>, ctx: UiContext, home: string): boolean {
  if (toolName === "find" || toolName === "fd") {
    if (getDirectSearchRoots(input).some((path) => isBroadUnsafeDirectSearchRoot(path, ctx, home))) return true;
    return getDirectReadNamePatternInputs(toolName, input).length === 0;
  }

  if (toolName === "ls" || toolName === "eza") {
    const paths = getDirectReadPathInputs(input);
    const listTargets = paths.length > 0 ? paths : ["."];
    return listTargets.some((path) => isBroadUnsafeDirectSearchRoot(path, ctx, home));
  }

  if (toolName !== "grep" && toolName !== "rg") return false;

  const globs: string[] = [];
  collectStringValues(input.glob, globs);

  const paths: string[] = [];
  for (const key of ["path", "paths", "file", "files"]) collectStringValues(input[key], paths);
  const searchPaths = paths.length > 0 ? paths : ["."];
  if (searchPaths.some((path) => isBroadUnsafeDirectSearchRoot(path, ctx, home))) return true;
  if (!searchPaths.some(isDirectoryLikeSearchPath)) return false;
  return !hasSafeConstrainingSearchGlob(globs, ctx, home);
}

function hasSafeConstrainingSearchGlob(globs: string[], ctx: UiContext, home: string): boolean {
  return globs.some((glob) => {
    const trimmed = glob.trim();
    return trimmed.length > 0 && !trimmed.startsWith("!") && !isSensitiveReadPath(trimmed, ctx, home);
  });
}

function getDirectSearchRoots(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "paths"]) collectStringValues(input[key], paths);
  return paths.length > 0 ? paths : ["."];
}

function isBroadUnsafeDirectSearchRoot(rawPath: string, ctx: UiContext, home: string): boolean {
  const expanded = normalizeShellPathText(rawPath, home);
  if (isBroadUnsafeSearchRoot(expanded)) return true;
  const resolvedPath = resolveReadPath(expanded, ctx, home);
  return resolvedPath === "/" || resolvedPath === home;
}

function isDirectoryLikeSearchPath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "." || trimmed === "./" || trimmed === ".." || trimmed === "../") return true;
  if (trimmed.endsWith("/") || trimmed.endsWith("/.")) return true;

  const normalized = trimmed.replace(/\\/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.length > 0 && !basename.includes(".");
}

function findSensitiveBashReadPath(command: string, ctx: UiContext, home: string): string | undefined {
  for (const segment of splitShellCommandSegments(command)) {
    for (const candidate of getBashPathCandidates(segment, home)) {
      if (isSensitiveReadPath(candidate, ctx, home)) return candidate;
    }
  }
}

function getBashPathCandidates(segment: string, home: string): string[] {
  const tokens = getNormalizedShellTokens(segment, home);
  const commandIndex = tokens.findIndex((token) => !isShellAssignment(token));
  const assignmentTokens = commandIndex < 0 ? tokens : tokens.slice(0, commandIndex);
  const assignments = getShellAssignments(assignmentTokens);
  const rawPathCandidates = uniqueStrings([
    ...getShellPathReferenceCandidates(tokens),
    ...getShellAssignmentPathCandidates(assignmentTokens),
    ...getShellExpansionPathCandidates(tokens, assignments, home),
  ]);
  if (commandIndex < 0) return rawPathCandidates;

  const commandName = getCommandName(tokens[commandIndex]!);
  const args = tokens.slice(commandIndex + 1);
  let parsedPathCandidates: string[];

  if (commandName === "git") parsedPathCandidates = getGitPathCandidates(args);
  else if (commandName === "find") parsedPathCandidates = getFindPathCandidates(args);
  else if (commandName === "fd") parsedPathCandidates = getFdPathCandidates(args);
  else if (commandName === "rg" && hasOption(args, "--files")) parsedPathCandidates = getAllPositionalPathCandidates(args);
  else if (SEARCH_PATTERN_COMMANDS.has(commandName)) parsedPathCandidates = getPatternThenPathCandidates(args);
  else if (commandName === "file") {
    parsedPathCandidates = getGenericPathCandidates(args, FILE_COMMAND_FILE_LIST_OPTIONS, FILE_COMMAND_SHORT_FILE_LIST_OPTIONS);
  } else parsedPathCandidates = getGenericPathCandidates(args);

  return uniqueStrings([
    ...rawPathCandidates,
    ...parsedPathCandidates,
    ...(bashReadCommandDefaultsToCwd(commandName, args) ? ["."] : []),
  ]);
}

function normalizeShellPathText(value: string, home: string): string {
  return value
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home)
    .replace(/\$'([^']*)'/g, (_match, content: string) => decodeAnsiCString(content))
    .replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (_match, content: string) => content.replace(/\\(.)/g, "$1"))
    .replace(/'([^']*)'/g, "$1")
    .replace(/\\([^\s])/g, "$1");
}

function decodeAnsiCString(content: string): string {
  return content.replace(/\\(?:x([0-9A-Fa-f]{1,2})|u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([0-7]{1,3})|([abefnrtv\\'"]))/g, (
    match: string,
    hexByte?: string,
    bracedUnicode?: string,
    shortUnicode?: string,
    longUnicode?: string,
    octal?: string,
    escaped?: string,
  ) => {
    const codePointText = hexByte ?? bracedUnicode ?? shortUnicode ?? longUnicode;
    if (codePointText) {
      const codePoint = Number.parseInt(codePointText, 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
    switch (escaped) {
      case "a": return "\x07";
      case "b": return "\b";
      case "e": return "\x1B";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "v": return "\v";
      default: return escaped ?? match;
    }
  });
}

function getNormalizedShellTokens(value: string, home: string): string[] {
  return tokenizeShellLike(value)
    .map((token) => cleanShellToken(normalizeShellPathText(token, home)))
    .filter((token): token is string => token !== undefined);
}

function tokenizeShellLike(value: string): string[] {
  const tokens: string[] = [];
  let token = "";

  const pushToken = () => {
    if (token.length > 0) {
      tokens.push(token);
      token = "";
    }
  };

  for (let i = 0; i < value.length;) {
    const char = value[i]!;

    if (/\s/.test(char)) {
      pushToken();
      i += 1;
      continue;
    }

    if (char === "\\") {
      if (i + 1 < value.length) {
        token += value[i + 1]!;
        i += 2;
      } else {
        token += char;
        i += 1;
      }
      continue;
    }

    if (char === "$" && value[i + 1] === "'") {
      const end = readQuotedEnd(value, i + 2, "'");
      token += value.slice(i, end);
      i = end;
      continue;
    }

    if (char === "'") {
      const end = readQuotedEnd(value, i + 1, "'");
      token += value.slice(i + 1, end - (value[end - 1] === "'" ? 1 : 0));
      i = end;
      continue;
    }

    if (char === "\"") {
      const result = readDoubleQuotedText(value, i + 1);
      token += result.text;
      i = result.end;
      continue;
    }

    if (char === "$" && value[i + 1] === "(") {
      const end = readCommandSubstitutionEnd(value, i);
      token += value.slice(i, end);
      i = end;
      continue;
    }

    if (char === "`") {
      const end = readBacktickEnd(value, i + 1);
      token += value.slice(i, end);
      i = end;
      continue;
    }

    token += char;
    i += 1;
  }

  pushToken();
  return tokens;
}

function readQuotedEnd(value: string, start: number, quote: string): number {
  const end = value.indexOf(quote, start);
  return end < 0 ? value.length : end + 1;
}

function readDoubleQuotedText(value: string, start: number): { text: string; end: number } {
  let text = "";
  for (let i = start; i < value.length; i += 1) {
    const char = value[i]!;
    if (char === "\"") return { text, end: i + 1 };
    if (char === "\\" && i + 1 < value.length) {
      text += value[i + 1]!;
      i += 1;
      continue;
    }
    text += char;
  }
  return { text, end: value.length };
}

function readCommandSubstitutionEnd(value: string, start: number): number {
  let depth = 0;
  for (let i = start; i < value.length;) {
    const char = value[i]!;
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "'") {
      i = readQuotedEnd(value, i + 1, "'");
      continue;
    }
    if (char === "\"") {
      i = readDoubleQuotedText(value, i + 1).end;
      continue;
    }
    if (char === "`") {
      i = readBacktickEnd(value, i + 1);
      continue;
    }
    if (char === "$" && value[i + 1] === "(") {
      depth += 1;
      i += 2;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      i += 1;
      if (depth <= 0) return i;
      continue;
    }
    i += 1;
  }
  return value.length;
}

function readBacktickEnd(value: string, start: number): number {
  for (let i = start; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      i += 1;
      continue;
    }
    if (value[i] === "`") return i + 1;
  }
  return value.length;
}

function cleanShellToken(token: string): string | undefined {
  const cleaned = token.trim().replace(/^[({[]+|[)},\]]+$/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

function getShellPathReferenceCandidates(tokens: string[]): string[] {
  const paths: string[] = [];
  const pathReference = /(?:~(?:[A-Za-z0-9._-]+)?(?:\/[^\s"'`;&|<>,)]*)?|\/[^\s"'`;&|<>,)]*|\.\.?\/[^\s"'`;&|<>,)]*)/g;
  for (const token of tokens) {
    if (isPathExpansionCandidate(token)) paths.push(token);
    for (const match of token.matchAll(pathReference)) {
      if (match[0] !== "." && match[0] !== "..") paths.push(match[0]);
    }
  }
  return uniqueStrings(paths);
}

function getShellAssignmentPathCandidates(tokens: string[]): string[] {
  const paths: string[] = [];
  for (const token of tokens) {
    const eqIndex = token.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = token.slice(0, eqIndex);
    const value = token.slice(eqIndex + 1);
    if (!value || !isPathLikeAssignmentName(name)) continue;
    paths.push(...value.split(":").filter((part) => part.length > 0));
  }
  return uniqueStrings(paths);
}

function getShellAssignments(tokens: string[]): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const token of tokens) {
    const eqIndex = token.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = token.slice(0, eqIndex);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) assignments.set(name, token.slice(eqIndex + 1));
  }
  return assignments;
}

function getShellExpansionPathCandidates(tokens: string[], assignments: Map<string, string>, home: string): string[] {
  const candidates: string[] = [];
  for (const token of tokens) {
    if (!token.includes("$")) continue;
    for (const variant of getShellExpansionVariants(token, assignments, home)) {
      if (isPathExpansionCandidate(variant)) candidates.push(variant);
    }
  }
  return uniqueStrings(candidates);
}

function getShellExpansionVariants(token: string, assignments: Map<string, string>, home: string): string[] {
  const variants = new Set<string>();
  const exactHomeExpanded = token
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home);
  if (exactHomeExpanded !== token) variants.add(exactHomeExpanded);

  const complexHomeCollapsed = token
    .replace(/(?:\$\{HOME[^}]+\})+/g, "~")
    .replace(/\$HOME\b/g, home);
  if (complexHomeCollapsed !== token) variants.add(complexHomeCollapsed);

  let assignedExpanded = exactHomeExpanded;
  for (const [name, value] of assignments) {
    const escapedName = escapeRegExp(name);
    assignedExpanded = assignedExpanded
      .replace(new RegExp(`\\$\\{${escapedName}\\}`, "g"), value)
      .replace(new RegExp(`\\$${escapedName}\\b`, "g"), value);
  }
  if (assignedExpanded !== token) variants.add(assignedExpanded);

  const wildcardExpanded = exactHomeExpanded
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}/g, "*")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "*");
  if (wildcardExpanded !== token) variants.add(wildcardExpanded);

  const commandSubstitutionCollapsed = exactHomeExpanded
    .replace(/\$\([^)]*(?:\)|$)/g, "*")
    .replace(/`[^`]*(?:`|$)/g, "*");
  if (commandSubstitutionCollapsed !== token) variants.add(commandSubstitutionCollapsed);

  return Array.from(variants);
}

function bashReadCommandDefaultsToCwd(commandName: string, args: string[]): boolean {
  if (commandName === "git") return gitCommandDefaultsToCwd(args);
  if (!CWD_DEFAULTING_BASH_COMMANDS.has(commandName)) return false;
  if (commandName === "find") return getFindSearchRoots(args).length === 0;
  if (commandName === "fd") return getFdPositionalArgs(args).length < 2;
  if (commandName === "rg") return getPatternThenPathCandidates(args).length === 0;
  return getPositionalArgs(args).length === 0;
}

function gitCommandDefaultsToCwd(args: string[]): boolean {
  return !gitArgsSetWorkingDirectory(args);
}

function gitArgsSetWorkingDirectory(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return false;
    if (arg === "-C" && args[i + 1] !== undefined && args[i + 1] !== "--") return true;
    if (arg.startsWith("-C") && arg.length > 2) return true;
    if (arg === "--work-tree" && args[i + 1] !== undefined && args[i + 1] !== "--") return true;
    if (arg.startsWith("--work-tree=")) return true;
    if (arg === "--git-dir" && args[i + 1] !== undefined && args[i + 1] !== "--") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--git-dir=")) continue;
    if (consumesGitOptionValue(args, i)) i += 1;
    if (!arg.startsWith("-")) return false;
  }
  return false;
}

function isPathExpansionCandidate(value: string): boolean {
  return value.includes("/") || value.startsWith("~") || value.startsWith(".");
}

function isPathLikeAssignmentName(name: string): boolean {
  return /(?:^|_)(?:PATH|DIR|FILE|HOME|ROOT|CONFIG|KEY)$/i.test(name);
}

function isShellAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function getCommandName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function getPatternThenPathCandidates(args: string[]): string[] {
  const paths: string[] = [];
  let sawPattern = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    const pathOption = collectPathBearingOptionValue(args, i, paths);
    if (pathOption) {
      if (isPatternSourceOption(pathOption.option)) sawPattern = true;
      if (pathOption.consumeNext) i += 1;
      continue;
    }
    const patternOption = getPatternBearingOptionValue(args, i);
    if (patternOption) {
      sawPattern = true;
      if (patternOption.consumeNext) i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (!sawPattern) {
      sawPattern = true;
      continue;
    }
    paths.push(arg);
  }

  return paths;
}

function getFdPathCandidates(args: string[]): string[] {
  const paths: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    const pathOption = collectPathBearingOptionValue(args, i, paths);
    if (pathOption) {
      if (pathOption.consumeNext) i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    paths.push(arg);
  }

  return paths;
}

function getAllPositionalPathCandidates(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    const pathOption = collectPathBearingOptionValue(args, i, paths);
    if (pathOption) {
      if (pathOption.consumeNext) i += 1;
      continue;
    }
    const patternOption = getPatternBearingOptionValue(args, i);
    if (patternOption) {
      if (patternOption.consumeNext) i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    paths.push(arg);
  }
  return paths;
}

function collectPathBearingOptionValue(
  args: string[],
  index: number,
  paths: string[],
  pathOptions = PATH_BEARING_BASH_OPTIONS,
  shortPathOptions = SHORT_PATH_BEARING_BASH_OPTIONS,
): { option: string; consumeNext: boolean } | undefined {
  const arg = args[index]!;
  if (!arg.startsWith("-") || arg === "--") return;

  const eqIndex = arg.indexOf("=");
  if (eqIndex > 0) {
    const option = arg.slice(0, eqIndex);
    if (pathOptions.has(option)) paths.push(arg.slice(eqIndex + 1));
    return pathOptions.has(option) ? { option, consumeNext: false } : undefined;
  }

  const shortOption = arg.slice(0, 2);
  if (arg.length > 2 && shortPathOptions.has(shortOption)) {
    paths.push(arg.slice(2));
    return { option: shortOption, consumeNext: false };
  }

  if (!pathOptions.has(arg)) return;
  const next = args[index + 1];
  if (next && next !== "--") {
    paths.push(next);
    return { option: arg, consumeNext: true };
  }
  return { option: arg, consumeNext: false };
}

function getPatternBearingOptionValue(args: string[], index: number): { option: string; consumeNext: boolean } | undefined {
  const arg = args[index]!;
  if (!arg.startsWith("-") || arg === "--") return;

  const eqIndex = arg.indexOf("=");
  if (eqIndex > 0) {
    const option = arg.slice(0, eqIndex);
    return PATTERN_BEARING_BASH_OPTIONS.has(option) ? { option, consumeNext: false } : undefined;
  }

  const shortOption = arg.slice(0, 2);
  if (arg.length > 2 && SHORT_PATTERN_BEARING_BASH_OPTIONS.has(shortOption)) {
    return { option: shortOption, consumeNext: false };
  }

  if (!PATTERN_BEARING_BASH_OPTIONS.has(arg)) return;
  const next = args[index + 1];
  return { option: arg, consumeNext: next !== undefined && next !== "--" };
}

function isPatternSourceOption(option: string): boolean {
  return option === "-f" || option === "--file" || option === "--from-file";
}

function getFindPathCandidates(args: string[]): string[] {
  const paths: string[] = [];
  let beforeExpression = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg === "(" || arg === "!" || arg === ")") {
      beforeExpression = false;
      continue;
    }
    const fileListOption = collectPathBearingOptionValue(args, i, paths, FIND_FILE_LIST_OPTIONS, NO_SHORT_PATH_BEARING_BASH_OPTIONS);
    if (fileListOption) {
      if (fileListOption.consumeNext) i += 1;
      beforeExpression = false;
      continue;
    }
    if (beforeExpression && FIND_PREFIX_OPTIONS.has(arg)) continue;
    if (beforeExpression && FIND_PREFIX_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (FIND_PATH_PREDICATES.has(arg)) {
      const next = args[indexAfterPredicate(args, i)];
      if (next && next !== "--") paths.push(next);
      beforeExpression = false;
      i = indexAfterPredicate(args, i);
      continue;
    }
    if (arg.startsWith("-")) {
      beforeExpression = false;
      continue;
    }
    if (beforeExpression) paths.push(arg);
  }
  return paths;
}

function getGitPathCandidates(args: string[]): string[] {
  const paths: string[] = [];
  let subcommandIndex = -1;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      subcommandIndex = i + 1;
      break;
    }
    const pathOption = collectGitPathOptionValue(args, i, paths);
    if (pathOption) {
      if (pathOption.consumeNext) i += 1;
      continue;
    }
    if (consumesGitOptionValue(args, i)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    subcommandIndex = i;
    break;
  }

  if (subcommandIndex < 0 || subcommandIndex >= args.length) return paths;
  const subcommand = args[subcommandIndex]!;
  const rest = args.slice(subcommandIndex + 1);
  const subcommandPathCandidates = subcommand === "config"
    ? getGitConfigPathCandidates(rest)
    : getGenericPathCandidates(rest, GIT_FILE_CONSUMING_OPTIONS, NO_SHORT_PATH_BEARING_BASH_OPTIONS);
  return uniqueStrings([...paths, ...subcommandPathCandidates]);
}

function collectGitPathOptionValue(args: string[], index: number, paths: string[]): { consumeNext: boolean } | undefined {
  const arg = args[index]!;
  const eqIndex = arg.indexOf("=");
  if (eqIndex > 0) {
    const option = arg.slice(0, eqIndex);
    if (GIT_PATH_BEARING_OPTIONS.has(option)) {
      paths.push(arg.slice(eqIndex + 1));
      return { consumeNext: false };
    }
  }

  if (arg.length > 2 && arg.startsWith("-C")) {
    paths.push(arg.slice(2));
    return { consumeNext: false };
  }

  if (!GIT_PATH_BEARING_OPTIONS.has(arg)) return;
  const next = args[index + 1];
  if (next && next !== "--") {
    paths.push(next);
    return { consumeNext: true };
  }
  return { consumeNext: false };
}

function consumesGitOptionValue(args: string[], index: number): boolean {
  const arg = args[index]!;
  if (arg === "-c" || arg === "--config-env") return args[index + 1] !== undefined && args[index + 1] !== "--";
  if (arg.startsWith("-c") && arg.length > 2) return false;
  return GIT_VALUE_OPTIONS.has(arg);
}

function getGitConfigPathCandidates(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const pathOption = collectGitConfigPathOptionValue(args, i, paths);
    if (pathOption) {
      if (pathOption.consumeNext) i += 1;
      continue;
    }
  }
  return uniqueStrings([...paths, ...getGenericPathCandidates(args)]);
}

function collectGitConfigPathOptionValue(args: string[], index: number, paths: string[]): { consumeNext: boolean } | undefined {
  const arg = args[index]!;
  const eqIndex = arg.indexOf("=");
  if (eqIndex > 0) {
    const option = arg.slice(0, eqIndex);
    if (GIT_CONFIG_PATH_OPTIONS.has(option)) {
      paths.push(arg.slice(eqIndex + 1));
      return { consumeNext: false };
    }
  }

  if (arg.length > 2 && arg.startsWith("-f")) {
    paths.push(arg.slice(2));
    return { consumeNext: false };
  }

  if (!GIT_CONFIG_PATH_OPTIONS.has(arg)) return;
  const next = args[index + 1];
  if (next && next !== "--") {
    paths.push(next);
    return { consumeNext: true };
  }
  return { consumeNext: false };
}

function getGenericPathCandidates(
  args: string[],
  pathOptions = GENERIC_PATH_BEARING_BASH_OPTIONS,
  shortPathOptions = NO_SHORT_PATH_BEARING_BASH_OPTIONS,
): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      paths.push(...args.slice(i + 1));
      break;
    }
    const pathOption = collectPathBearingOptionValue(
      args,
      i,
      paths,
      pathOptions,
      shortPathOptions,
    );
    if (pathOption) {
      if (pathOption.consumeNext) i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    paths.push(arg);
  }
  return paths;
}

function indexAfterPredicate(args: string[], index: number): number {
  return args[index + 1] === "--" ? index + 2 : index + 1;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isSensitiveReadPath(rawPath: string, ctx: UiContext, home: string): boolean {
  for (const path of getPathReferenceVariants(rawPath)) {
    const candidates = [path, resolveReadPath(path, ctx, home)];
    if (candidates.some((candidate) => splitPathSegments(candidate).some(isSensitivePathSegment))) return true;
  }
  return false;
}

function getPathReferenceVariants(rawPath: string): string[] {
  const trimmed = rawPath.trim();
  if (!trimmed) return [];

  const variants = [trimmed];
  const withoutGlob = stripGlobSyntax(trimmed);
  if (withoutGlob !== trimmed) {
    variants.push(withoutGlob);
    variants.push(...withoutGlob.split(","));
  }

  return Array.from(new Set(variants.map((variant) => variant.trim()).filter((variant) => variant.length > 0)));
}

function stripGlobSyntax(value: string): string {
  return value.replace(/[*?[\]{}]/g, "");
}

function hasGlobSyntax(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function pathPatternMayReferencePath(patternPath: string, literalPath: string): boolean {
  const patternSegments = splitPathSegments(patternPath);
  const literalSegments = splitPathSegments(literalPath);
  if (patternSegments.length === 0 || literalSegments.length === 0) return false;

  const segmentCount = Math.min(patternSegments.length, literalSegments.length);
  for (let i = 0; i < segmentCount; i += 1) {
    if (!globSegmentCouldMatch(patternSegments[i]!, literalSegments[i]!)) return false;
  }
  return true;
}

function resolveReadPath(rawPath: string, ctx: UiContext, home: string): string {
  const tildePath = resolveTildePath(rawPath, home);
  if (tildePath !== undefined) return tildePath;
  if (rawPath.startsWith("/")) return resolve(rawPath);
  return resolve(ctx.cwd ?? process.cwd(), rawPath);
}

function resolveConfiguredPath(rawPath: string, home: string): string {
  return resolveTildePath(rawPath, home) ?? resolve(rawPath);
}

function resolveTildePath(rawPath: string, home: string): string | undefined {
  const currentHome = rawPath.match(/^~(?:\/+(.*))?$/);
  if (currentHome) return currentHome[1] ? resolve(home, stripLeadingPathSeparators(currentHome[1])) : home;

  const namedHome = rawPath.match(/^~[^/]+(?:\/+(.*))?$/);
  if (namedHome) return namedHome[1] ? resolve(home, stripLeadingPathSeparators(namedHome[1])) : home;

  return undefined;
}

function stripLeadingPathSeparators(value: string): string {
  return value.replace(/^[\\/]+/, "");
}

function splitPathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .replace(/:/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isSensitivePathSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (hasGlobSyntax(lower) && SENSITIVE_GLOB_MATCH_SEGMENTS.some((candidate) => globSegmentCouldMatch(lower, candidate))) return true;
  return isPlainSensitivePathSegment(stripGlobSyntax(lower));
}

function isPlainSensitivePathSegment(lower: string): boolean {
  if (lower.startsWith(".env")) return true;
  if (SENSITIVE_CREDENTIAL_PATH_SEGMENTS.has(lower)) return true;
  if (SENSITIVE_CREDENTIAL_FILES.has(lower)) return true;
  if (/(?:^|[-_.])(?:credential|credentials|token|tokens|secret|secrets|auth)(?:$|[-_.])/.test(lower)) return true;
  if (/(?:^|[-_.])private[-_.]?key(?:$|[-_.])/.test(lower)) return true;

  const stem = getFilenameStem(lower);
  if (SENSITIVE_FILE_STEMS.has(stem)) return true;
  if (/^private[-_.]?key$/.test(stem)) return true;
  return false;
}

function globSegmentCouldMatch(pattern: string, literal: string): boolean {
  if (!hasGlobSyntax(pattern)) return pattern.toLowerCase() === literal.toLowerCase();

  try {
    return new RegExp(`^${globSegmentToRegExpSource(pattern)}$`, "i").test(literal);
  } catch {
    return true;
  }
}

function globSegmentToRegExpSource(value: string): string {
  let source = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    if (char === "[") {
      const end = value.indexOf("]", i + 1);
      if (end > i + 1) {
        source += globCharacterClassToRegExpSource(value.slice(i + 1, end));
        i = end;
        continue;
      }
    }
    if (char === "{") {
      const end = value.indexOf("}", i + 1);
      if (end > i + 1) {
        const alternatives = value.slice(i + 1, end).split(",");
        source += `(?:${alternatives.map(globSegmentToRegExpSource).join("|")})`;
        i = end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return source;
}

function globCharacterClassToRegExpSource(content: string): string {
  const isNegated = content.startsWith("!") || content.startsWith("^");
  const classBody = isNegated ? content.slice(1) : content;
  if (!classBody) return "\\[\\]";
  return `[${isNegated ? "^" : ""}${classBody.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function getFilenameStem(segment: string): string {
  const withoutGlob = segment.replace(/[*?[\]{}]/g, "");
  const stemSource = withoutGlob.startsWith(".") ? withoutGlob.slice(1) : withoutGlob;
  const dotIndex = stemSource.indexOf(".");
  return dotIndex >= 0 ? stemSource.slice(0, dotIndex) : stemSource;
}

function isSafeDefaultReadCommand(command: string, ctx: UiContext, home: string): boolean {
  const stripped = stripAllowedStderrNullRedirects(command.trim());
  if (!stripped || hasUnsafeDefaultShellSyntax(stripped)) return false;
  return stripped.split("|").every((segment) => isSafeDefaultReadCommandSegment(segment.trim(), ctx, home));
}

function stripAllowedStderrNullRedirects(command: string): string | undefined {
  const stripped = command.replace(/(^|\s)2>\s*\/dev\/null(?=\s|$)/g, " ").trim();
  if (/[<>]/.test(stripped)) return;
  return stripped;
}

function hasUnsafeDefaultShellSyntax(command: string): boolean {
  return /[\r\n;]/.test(command)
    || /&/.test(command)
    || /&&|\|\|/.test(command)
    || /`|\$\s*\(|<\(|>\(/.test(command)
    || /\$(?!HOME\b|\{HOME\})/.test(command)
    || /["'\\]/.test(command)
    || /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|i|ci|run|exec|publish|remove|uninstall|update)\b/i.test(command)
    || /\b(?:python|python3|node|ruby|perl|php|deno|bun)\s+-[ce]\b/i.test(command);
}

function isSafeDefaultReadCommandSegment(segment: string, ctx: UiContext, home: string): boolean {
  const tokens = tokenizeShellLike(segment);
  const commandIndex = tokens.findIndex((token) => !isShellAssignment(token));
  if (commandIndex < 0) return false;
  if (commandIndex > 0) return false;

  const commandToken = tokens[commandIndex]!;
  if (isPathQualifiedCommandToken(commandToken)) return false;

  const commandName = commandToken.toLowerCase();
  const args = tokens.slice(commandIndex + 1);

  if (commandName === "git") return isSafeDefaultGitCommand(args);
  if (!DEFAULT_SAFE_BASH_COMMANDS.has(commandName)) return false;
  return !hasUnsafeDefaultReadOptions(commandName, args, ctx, home);
}

function isPathQualifiedCommandToken(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

function isSafeDefaultGitCommand(args: string[]): boolean {
  const subcommand = args[0];
  if (!subcommand) return false;
  const rest = args.slice(1);

  if (hasOption(rest, "--output") || hasPathBearingOption(args, GIT_FILE_CONSUMING_OPTIONS)) return false;
  if (subcommand === "status" || subcommand === "ls-files" || subcommand === "ls-tree") return true;
  if (subcommand === "config") return false;
  if (subcommand === "remote") return rest.length === 0 || rest.every((arg) => arg === "-v" || arg === "--verbose");
  if (subcommand === "branch") {
    return rest.every((arg) =>
      ["-a", "-r", "-v", "-vv", "--all", "--remotes", "--show-current", "--contains", "--merged", "--no-merged"].includes(arg),
    );
  }

  return false;
}

function hasUnsafeDefaultReadOptions(commandName: string, args: string[], ctx: UiContext, home: string): boolean {
  if (hasUnsafeSpecialDeviceRead(args)) return true;
  if (hasPathBearingOption(args, INDIRECT_FILE_LIST_OPTIONS)) return true;

  if (commandName === "find") {
    return args.some((arg) => /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint0?|fprintf)$/.test(arg))
      || hasPathBearingOption(args, FIND_FILE_LIST_OPTIONS)
      || hasUnsafeDefaultFindTraversal(args, ctx, home);
  }

  if (commandName === "grep") {
    return hasShortFlag(args, "R") || hasShortFlag(args, "r")
      || hasOption(args, "--recursive") || hasOption(args, "--dereference-recursive")
      || hasGrepRecursiveDirectoryOption(args);
  }

  if (commandName === "fd") {
    return args.some((arg) =>
      arg === "-x" || arg === "-X" || arg === "--exec" || arg === "--exec-batch"
      || arg.startsWith("--exec=") || arg.startsWith("--exec-batch="),
    )
      || hasShortFlag(args, "H") || hasShortFlag(args, "I") || hasShortFlag(args, "u")
      || hasOption(args, "--hidden") || hasOption(args, "--no-ignore") || hasOption(args, "--unrestricted")
      || hasUnsafeDefaultFdTraversal(args, ctx, home);
  }

  if (commandName === "ls" || commandName === "eza") return hasUnsafeDefaultListTraversal(args, ctx, home);
  if (commandName === "du") return hasUnsafeDefaultDuTraversal(args, ctx, home);
  if (commandName === "tail") return hasShortFlag(args, "f") || hasShortFlag(args, "F") || hasOption(args, "--follow");
  if (commandName === "sort") return hasOption(args, "-o") || hasOption(args, "--output");
  if (commandName === "diff") return hasOption(args, "--output") || hasUnsafeDefaultDiffTraversal(args, ctx, home);
  if (commandName === "file") {
    return hasPathBearingOption(args, FILE_COMMAND_FILE_LIST_OPTIONS, FILE_COMMAND_SHORT_FILE_LIST_OPTIONS);
  }
  if (commandName === "bat") return hasUnsafeBatOptions(args);
  if (commandName === "rg") {
    return hasOption(args, "--pre") || hasOption(args, "--hidden") || hasShortFlag(args, "u")
      || getRgGlobValues(args).some((glob) => glob.trim().startsWith("!"))
      || hasOption(args, "--files")
      || hasUnsafeDefaultRgTraversal(args);
  }

  return false;
}

function hasUnsafeBatOptions(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--pager" || arg.startsWith("--pager=")) return true;
    if (arg === "--config-file" || arg.startsWith("--config-file=")) return true;

    if (arg === "--paging") {
      const value = args[i + 1];
      if (value !== "never") return true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--paging=") && arg.slice("--paging=".length) !== "never") return true;
  }

  return false;
}

function hasUnsafeSpecialDeviceRead(args: string[]): boolean {
  return args.some((arg) => /^\/dev\/(?:zero|u?random|full|[sh]d[a-z]|nvme\d+n\d+|disk\/)/.test(arg));
}

function hasUnsafeDefaultFindTraversal(args: string[], ctx: UiContext, home: string): boolean {
  const roots = getFindSearchRoots(args);
  const effectiveRoots = roots.length > 0 ? roots : ["."];
  if (effectiveRoots.some((root) => isBroadUnsafeSearchRootForCwd(root, ctx, home))) return true;
  return !getFindConstrainingPatterns(args).some(isConcreteNonCatchallSearchPattern);
}

function getFindSearchRoots(args: string[]): string[] {
  const roots: string[] = [];
  let beforeExpression = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg === "(" || arg === "!" || arg === ")") {
      beforeExpression = false;
      continue;
    }
    const fileListOption = collectPathBearingOptionValue(args, i, [], FIND_FILE_LIST_OPTIONS, NO_SHORT_PATH_BEARING_BASH_OPTIONS);
    if (fileListOption) {
      if (fileListOption.consumeNext) i += 1;
      beforeExpression = false;
      continue;
    }
    if (beforeExpression && FIND_PREFIX_OPTIONS.has(arg)) continue;
    if (beforeExpression && FIND_PREFIX_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (FIND_PATH_PREDICATES.has(arg)) {
      beforeExpression = false;
      i = indexAfterPredicate(args, i);
      continue;
    }
    if (arg.startsWith("-")) {
      beforeExpression = false;
      continue;
    }
    if (beforeExpression) roots.push(arg);
  }

  return roots;
}

function hasUnsafeDefaultListTraversal(args: string[], ctx: UiContext, home: string): boolean {
  const paths = getPositionalArgs(args);
  const listTargets = paths.length > 0 ? paths : ["."];
  return hasShortFlag(args, "R")
    || hasOption(args, "--recursive")
    || listTargets.some((path) => isBroadUnsafeSearchRootForCwd(path, ctx, home));
}

function hasUnsafeDefaultDuTraversal(args: string[], ctx: UiContext, home: string): boolean {
  const paths = getPositionalArgs(args);
  return paths.length === 0 || paths.some((path) => isBroadUnsafeSearchRootForCwd(path, ctx, home));
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  return positional;
}

function getFindConstrainingPatterns(args: string[]): string[] {
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!FIND_PATH_PREDICATES.has(arg)) continue;
    const valueIndex = indexAfterPredicate(args, i);
    const value = args[valueIndex];
    if (value && value !== "--") patterns.push(value);
    i = valueIndex;
  }
  return patterns;
}

function hasUnsafeDefaultFdTraversal(args: string[], ctx: UiContext, home: string): boolean {
  const positional = getFdPositionalArgs(args);
  const pattern = positional[0];
  if (!pattern || !isConcreteNonCatchallSearchPattern(pattern)) return true;
  const roots = getFdSearchRoots(args, positional);
  const effectiveRoots = roots.length > 0 ? roots : ["."];
  return effectiveRoots.some((root) => isBroadUnsafeSearchRootForCwd(root, ctx, home));
}

function getFdSearchRoots(args: string[], positional = getFdPositionalArgs(args)): string[] {
  const roots = [...positional.slice(1)];
  for (let i = 0; i < args.length; i += 1) {
    const pathOption = collectPathBearingOptionValue(
      args,
      i,
      roots,
      FD_SEARCH_ROOT_OPTIONS,
      NO_SHORT_PATH_BEARING_BASH_OPTIONS,
    );
    if (pathOption?.consumeNext) i += 1;
  }
  return roots;
}

function getFdPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex > 0 && FD_OPTIONS_WITH_VALUE.has(arg.slice(0, eqIndex))) continue;
    const shortOption = arg.slice(0, 2);
    if (arg.length > 2 && FD_OPTIONS_WITH_VALUE.has(shortOption)) continue;
    if (FD_OPTIONS_WITH_VALUE.has(arg) && args[i + 1] !== undefined && args[i + 1] !== "--") i += 1;
  }
  return positional;
}

function isConcreteNonCatchallSearchPattern(value: string): boolean {
  const normalized = stripGlobSyntax(value.trim()).trim();
  return normalized.length > 0 && normalized !== "." && normalized !== "/";
}

function isBroadUnsafeSearchRoot(value: string): boolean {
  const home = homedir();
  const normalized = normalizeShellPathText(value.trim(), home);
  if (normalized === "/" || normalized === "/*" || normalized === "~") return true;
  const resolved = resolveAbsoluteShellTarget(normalized, home);
  return resolved === "/" || resolved === home;
}

function isBroadUnsafeSearchRootForCwd(value: string, ctx: UiContext, home: string): boolean {
  const normalized = normalizeShellPathText(value.trim(), home);
  if (isBroadUnsafeSearchRoot(normalized)) return true;
  const resolved = resolveReadPath(normalized, ctx, home);
  return resolved === "/" || resolved === home;
}

function hasUnsafeDefaultDiffTraversal(args: string[], ctx: UiContext, home: string): boolean {
  return hasShortFlag(args, "r")
    || hasOption(args, "--recursive")
    || getPositionalArgs(args).some((path) => isBroadUnsafeSearchRootForCwd(path, ctx, home));
}

function hasGrepRecursiveDirectoryOption(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-d" || arg === "--directories") {
      if (args[i + 1] === "recurse") return true;
      continue;
    }
    if (arg === "--directories=recurse" || arg === "-drecurse") return true;
  }
  return false;
}

function hasUnsafeDefaultRgTraversal(args: string[]): boolean {
  const paths = getPatternThenPathCandidates(args);
  return paths.length === 0 || paths.some(isDirectoryLikeSearchPath);
}

function getRgGlobValues(args: string[]): string[] {
  const globs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-g" || arg === "--glob" || arg === "--iglob") {
      if (args[i + 1] && args[i + 1] !== "--") {
        globs.push(args[i + 1]!);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("-g") && arg.length > 2) globs.push(arg.slice(2));
    else if (arg.startsWith("--glob=")) globs.push(arg.slice("--glob=".length));
    else if (arg.startsWith("--iglob=")) globs.push(arg.slice("--iglob=".length));
  }
  return globs;
}

function hasOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`) || (option.length === 2 && arg.startsWith(option) && arg.length > 2));
}

function hasPathBearingOption(
  args: string[],
  pathOptions: Set<string>,
  shortPathOptions = NO_SHORT_PATH_BEARING_BASH_OPTIONS,
): boolean {
  for (let i = 0; i < args.length; i += 1) {
    if (collectPathBearingOptionValue(args, i, [], pathOptions, shortPathOptions)) return true;
  }
  return false;
}

function hasShortFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes(flag));
}

function isSafePlanCommand(command: string): boolean {
  const stripped = stripAllowedStderrNullRedirects(command.trim());
  if (!stripped || hasUnsafePlanShellSyntax(stripped) || /sed\s+.*-i/.test(stripped)) return false;
  return stripped.split("|").every((segment) => isSafePlanCommandSegment(segment.trim()));
}

function hasUnsafePlanShellSyntax(command: string): boolean {
  return /[\r\n;]/.test(command)
    || /&&|\|\|/.test(command)
    || /&/.test(command)
    || /`|\$\s*\(|<\(|>\(/.test(command)
    || /\$(?!HOME\b|\{HOME\})/.test(command);
}

function isSafePlanCommandSegment(segment: string): boolean {
  if (!segment) return false;
  return SAFE_PLAN_BASH_PREFIXES.some((prefix) => shellSegmentMatchesSafePrefix(segment, prefix))
    && !hasUnsafePlanCommandOptions(segment);
}

function shellSegmentMatchesSafePrefix(segment: string, prefix: string): boolean {
  if (!segment.startsWith(prefix)) return false;
  if (prefix.endsWith("-")) return true;
  const next = segment[prefix.length];
  return next === undefined || /\s/.test(next);
}

function hasUnsafePlanCommandOptions(segment: string): boolean {
  const tokens = tokenizeShellLike(segment).map(cleanShellToken).filter((token): token is string => token !== undefined);
  const commandIndex = tokens.findIndex((token) => !isShellAssignment(token));
  if (commandIndex < 0) return true;

  const commandName = getCommandName(tokens[commandIndex]!);
  const args = tokens.slice(commandIndex + 1);

  if (hasUnsafeSpecialDeviceRead(args)) return true;

  if (commandName === "curl") {
    return hasOption(args, "-o")
      || hasOption(args, "--output")
      || hasOption(args, "--output-dir")
      || hasShortFlag(args, "O")
      || hasShortFlag(args, "J")
      || hasOption(args, "--remote-name")
      || hasOption(args, "--remote-header-name");
  }

  if (commandName === "npm" || commandName === "pnpm" || commandName === "yarn" || commandName === "bun") {
    return args[0] === "audit" && args.slice(1).some((arg) => arg === "fix" || arg === "--fix" || arg.startsWith("--fix="));
  }

  if (commandName === "sed") {
    return hasOption(args, "-i")
      || hasOption(args, "--in-place")
      || args.some((arg) => /(^|[;{\s])w(\s|$)/.test(arg));
  }

  if (commandName === "find") {
    return args.some((arg) => /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint0?|fprintf)$/.test(arg));
  }

  if (commandName === "fd") {
    return args.some((arg) =>
      arg === "-x" || arg === "-X" || arg === "--exec" || arg === "--exec-batch"
      || arg.startsWith("--exec=") || arg.startsWith("--exec-batch="),
    );
  }

  if (commandName === "less") return hasOption(args, "-o") || hasOption(args, "-O") || hasOption(args, "--log-file");
  if (commandName === "tree") return hasOption(args, "-o");
  if (commandName === "sort") return hasOption(args, "-o") || hasOption(args, "--output");
  if (commandName === "diff") return hasOption(args, "--output");
  if (commandName === "bat") return hasUnsafeBatOptions(args);
  if (commandName === "rg") return hasOption(args, "--pre");
  if (commandName === "git") return hasOption(args, "--output") || hasOption(args, "--ext-diff") || hasOption(args, "--textconv");
  if (commandName === "gh" && args[0] === "auth" && args[1] === "status") {
    const statusArgs = args.slice(2);
    return hasOption(statusArgs, "--show-token") || hasShortFlag(statusArgs, "t");
  }

  return false;
}

function findBuiltinCatastrophicBashCommand(command: string): Pattern | undefined {
  for (const segment of splitShellCommandSegments(command)) {
    const tokens = tokenizeShellLike(segment).map(cleanShellToken).filter((token): token is string => token !== undefined);
    const effectiveCommand = getEffectiveShellCommand(tokens);
    if (!effectiveCommand) continue;

    const { commandName, args } = effectiveCommand;
    if (isMkfsCommand(commandName)) return { pattern: commandName, description: "filesystem format" };
    if (commandName === "dd" && getDdOutputTargets(args).some(isRawDiskDevicePath)) {
      return { pattern: "dd of=", description: "raw disk write" };
    }
  }
}

function getEffectiveShellCommand(tokens: string[]): { commandName: string; args: string[] } | undefined {
  let commandIndex = tokens.findIndex((token) => !isShellAssignment(token));
  if (commandIndex < 0) return;

  let commandName = getCommandName(tokens[commandIndex]!);
  if (commandName === "sudo") {
    commandIndex = getSudoCommandIndex(tokens, commandIndex + 1);
    if (commandIndex < 0) return;
    commandName = getCommandName(tokens[commandIndex]!);
  }

  return { commandName, args: tokens.slice(commandIndex + 1) };
}

function getSudoCommandIndex(tokens: string[], start: number): number {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") return i + 1 < tokens.length ? i + 1 : -1;
    if (!token.startsWith("-")) return i;

    const option = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (SUDO_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) i += 1;
  }
  return -1;
}

const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-A", "-a", "-b", "-C", "-c", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u",
  "--askpass", "--close-from", "--chdir", "--group", "--host", "--prompt", "--role", "--type", "--user",
  "--command-timeout", "--login-class",
]);

function isMkfsCommand(commandName: string): boolean {
  return commandName === "mkfs" || commandName.startsWith("mkfs.");
}

function getDdOutputTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (const arg of args) {
    const match = arg.match(/^of=(.+)$/);
    if (match?.[1]) targets.push(match[1]);
  }
  return targets;
}

function isRawDiskDevicePath(path: string): boolean {
  return /^\/dev\/(?:[svx]?d[a-z]\d*|nvme\d+n\d+(?:p\d+)?|disk\/)/.test(path);
}

function checkCriticalRmRf(command: string, cwd = process.cwd(), home = homedir()): string | null {
  for (const targets of getRmRfTargetGroups(command, home)) {
    for (const target of targets) {
      if (hasUnresolvedShellExpansion(target)) {
        return `rm -rf ${target} — recursive delete target uses unresolved shell expansion`;
      }

      const resolved = resolveAbsoluteShellTarget(target, home) ?? resolveShellTarget(target, cwd);
      if (!resolved) continue;

      const normalized = resolved.replace(/\/+$/, "") || "/";
      if (normalized === "/") return "rm -rf / — recursive delete root";
      if (normalized === home) return "rm -rf ~ — recursive delete entire home directory";
      if (CRITICAL_DIRS.includes(normalized)) return `rm -rf ${normalized} — recursive delete critical system directory`;

      const globBase = getGlobbedRmBase(normalized);
      if (globBase) {
        if (globBase === "/") return "rm -rf / — recursive delete root";
        if (globBase === home) return "rm -rf ~ — recursive delete entire home directory";
        if (CRITICAL_DIRS.includes(globBase)) return `rm -rf ${globBase}/* — recursive delete critical system directory contents`;
      }
    }
  }

  return null;
}

function checkDangerousRmRf(command: string, cwd: string): { description: string } | null {
  for (const targets of getRmRfTargetGroups(command)) {
    const normalizedCwd = resolve(cwd);

    for (const target of targets) {
      const normalized = resolveShellTarget(target, cwd);
      if (normalized === normalizedCwd || normalized.startsWith(normalizedCwd + "/")) continue;
      return { description: `recursive force delete outside project (${target})` };
    }
  }

  return null;
}

function getRmRfTargetGroups(command: string, home = homedir()): string[][] {
  const groups: string[][] = [];
  const normalized = normalizeRmCommandText(command, home);
  for (const commandText of uniqueStrings([normalized, exposeNestedShellCommandText(normalized)])) {
    for (const segment of splitShellCommandSegments(commandText)) {
      const tokens = tokenizeShellLike(segment).map((token) => token.trim()).filter((token) => token.length > 0);
      for (let i = 0; i < tokens.length; i += 1) {
        const commandToken = tokens[i]!;
        if (getCommandName(commandToken) !== "rm" && !shellCommandTokenMayExpandToName(commandToken, "rm")) continue;
        const targets = getRecursiveForceRmTargets(tokens.slice(i + 1));
        if (targets.length > 0) groups.push(targets);
      }
    }
  }
  return groups;
}

function shellCommandTokenMayExpandToName(token: string, expectedName: string): boolean {
  const commandToken = getCommandName(token).toLowerCase();
  if (!/[$`]/.test(commandToken)) return false;

  const wildcard = "\u0000";
  const pattern = commandToken
    .replace(/\$\([^)]*(?:\)|$)/g, wildcard)
    .replace(/`[^`]*(?:`|$)/g, wildcard)
    .replace(/\$\{[^}]*\}/g, wildcard)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, wildcard);
  if (!pattern.includes(wildcard)) return false;

  const source = `^${pattern.split(wildcard).map(escapeRegExp).join(".*")}$`;
  return new RegExp(source).test(expectedName.toLowerCase());
}

function normalizeRmCommandText(command: string, home: string): string {
  return normalizeShellPathText(command, home).replace(/\$\{IFS\}|\$IFS\b/g, " ");
}

function exposeNestedShellCommandText(command: string): string {
  return command.replace(/\$\(/g, " ").replace(/[`()]/g, " ");
}

function hasUnresolvedShellExpansion(value: string): boolean {
  return /[$`]/.test(value);
}

function getGlobbedRmBase(targetPath: string): string | null {
  if (!hasGlobSyntax(targetPath)) return null;

  const normalized = targetPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const prefixSegments: string[] = [];
  for (const segment of segments) {
    if (hasGlobSyntax(segment)) break;
    prefixSegments.push(segment);
  }

  const prefix = prefixSegments.join("/") || (normalized.startsWith("/") ? "/" : "");
  return prefix.replace(/\/+$/, "") || "/";
}

function getRecursiveForceRmTargets(args: string[]): string[] {
  let recursive = false;
  let force = false;
  let endOfOptions = false;
  const targets: string[] = [];

  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && arg.startsWith("--")) {
      const option = arg.slice(0, arg.indexOf("=") > 0 ? arg.indexOf("=") : arg.length);
      if (option === "--recursive") recursive = true;
      if (option === "--force") force = true;
      continue;
    }

    if (!endOfOptions && /^-[A-Za-z]+$/.test(arg)) {
      const flags = arg.slice(1);
      if (/[rR]/.test(flags)) recursive = true;
      if (flags.includes("f")) force = true;
      continue;
    }

    targets.push(arg);
  }

  return recursive && force ? targets : [];
}

function resolveAbsoluteShellTarget(target: string, home = homedir()): string | null {
  const normalized = normalizeShellPathText(target, home);
  const homeParameterTarget = resolveHomeParameterShellTarget(normalized, home);
  if (homeParameterTarget) return homeParameterTarget;
  const tildePath = resolveTildePath(normalized, home);
  if (tildePath !== undefined) return tildePath;
  if (normalized === "/*") return "/";
  if (normalized.startsWith("/")) return resolve(normalized);
  return null;
}

function resolveHomeParameterShellTarget(target: string, home: string): string | null {
  const match = target.match(/^\$\{HOME(?:(?::[-=?+][^}]*)|(?:[-?+][^}]*)|(?:=[^}]*))?\}(?:\/(.*))?$/);
  if (!match) return null;
  return match[1] ? resolve(home, stripLeadingPathSeparators(match[1])) : home;
}

function resolveShellTarget(target: string, cwd: string): string {
  const home = homedir();
  const normalized = normalizeShellPathText(target, home);
  const tildePath = resolveTildePath(normalized, home);
  if (tildePath !== undefined) return tildePath;
  if (normalized.startsWith("/")) return resolve(normalized);
  return resolve(cwd, normalized);
}

function findMatch(command: string, patterns: Pattern[]): Pattern | undefined {
  return patterns.find((pattern) => command.includes(pattern.pattern));
}

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
  const lineWidth = visibleWidth(line);
  if (lineWidth <= maxWidth) return line;

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
  const tail = sliceByColumn(line, Math.max(0, lineWidth - tailWidth), tailWidth);
  const truncated = `${head}${ellipsis}${tail}`;

  // sliceByColumn() re-emits whatever ANSI style is active at the tail's start column (so the
  // tail still renders in the right color) but drops the line's own trailing reset code if it
  // falls outside the sliced window — the truncated line can then end mid-style, bleeding that
  // color/attribute into whatever the TUI renders next. Only append when the source line was
  // actually styled (render() lines are theme.fg()-wrapped); ANSI-free strings must stay
  // byte-identical for existing tests.
  return /\x1b\[[0-9;]*m/.test(line) ? `${truncated}\x1b[0m` : truncated;
}

// Renders a numbered dialog via ctx.ui.custom() so digit keys 1-9 resolve an option
// instantly (plus Up/Down/PageUp/PageDown/Enter/Escape/Ctrl+C), replacing ctx.ui.select().
// Falls back to ctx.ui.select() when ctx.mode !== "tui": RPC mode's real ctx.ui.custom() is
// a no-op stub that resolves undefined immediately without consulting the client, and
// ctx.hasUI is true under RPC too, so skipping this check would silently auto-deny every
// approval prompt for RPC-driven clients. Return contract matches ctx.ui.select(): a string
// from `options`, or undefined for cancel (treated as Deny by callers).
async function promptApprovalChoice(ctx: UiContext, title: string, options: string[]): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    return ctx.ui.select(title, options);
  }

  // `ctx.ui` is deliberately typed `any` (see UiContext) — the `custom()` call therefore
  // can't accept an explicit `<T>` type argument (TS2347); the `Promise<string | undefined>`
  // return type annotation on this function is what keeps callers type-safe instead.
  return ctx.ui.custom((tui: any, theme: any, kb: KeybindingsManager, done: (result: string | undefined) => void) => {
    let selectedIndex = 0;

    // Digit quick-pick is new functionality with no pre-existing keybinding action to honor,
    // so hard-coding 1-9 here is intentional. Navigation/confirm/cancel below go through the
    // real `kb.matches()` (same API the host's own SelectList/ExtensionSelectorComponent use)
    // so users who remapped their `tui.select.*` keybindings are honored here too.
    function handleInput(data: string) {
      for (let i = 0; i < options.length && i < 9; i++) {
        if (matchesKey(data, String(i + 1) as KeyId)) {
          done(options[i]);
          return;
        }
      }
      if (kb.matches(data, "tui.select.up")) {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        tui.requestRender();
        return;
      }
      if (kb.matches(data, "tui.select.down")) {
        selectedIndex = (selectedIndex + 1) % options.length;
        tui.requestRender();
        return;
      }
      if (kb.matches(data, "tui.select.pageUp")) {
        selectedIndex = 0;
        tui.requestRender();
        return;
      }
      if (kb.matches(data, "tui.select.pageDown")) {
        selectedIndex = options.length - 1;
        tui.requestRender();
        return;
      }
      if (kb.matches(data, "tui.select.confirm")) {
        done(options[selectedIndex]);
        return;
      }
      if (kb.matches(data, "tui.select.cancel")) {
        done(undefined);
        return;
      }
    }

    function render(width: number): string[] {
      // title may contain embedded "\n" for dangerous/catastrophic bash descriptions
      // (see describeApprovalRequest, extensions/index.ts) — split, do not push raw,
      // or the numbered dialog will visually break on the highest-stakes approvals.
      const lines = [...title.split("\n").map((line) => theme.fg("text", line)), ""];
      options.forEach((opt, i) => {
        const prefix = i === selectedIndex ? theme.fg("accent", "→ ") : "  ";
        lines.push(`${prefix}${i + 1}. ${opt}`);
      });
      lines.push("", theme.fg("dim", "↑↓ select • Enter confirm • 1-9 quick pick • Esc = Deny"));
      return lines.map((line) => truncateLineMiddle(line, width));
    }

    return { render, handleInput };
  });
}

async function promptApproval(
  toolName: string,
  input: Record<string, unknown>,
  ctx: UiContext,
  dangerousPatterns: Pattern[],
  catastrophicPatterns: Pattern[],
  sessionAllow: SessionAllow,
  allowCatastrophic: boolean,
): Promise<{ block: true; reason: string } | undefined> {
  const { icon, description } = describeApprovalRequest(toolName, input, dangerousPatterns, catastrophicPatterns, allowCatastrophic);
  const options = [
    "Allow once",
    toolName === "bash" ? "Allow this command for session" : `Allow all ${toolName} for session`,
    "Deny",
  ];

  const choice = await promptApprovalChoice(ctx, `${icon} ${description}`, options);
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
  allowCatastrophic: boolean,
): { icon: string; description: string } {
  if (toolName === "write") return { icon: "🔒", description: `write: ${input.path}` };
  if (toolName === "edit") return { icon: "🔒", description: `edit: ${input.path}` };
  if (toolName !== "bash") return { icon: "🔒", description: describeNonBashApprovalRequest(toolName, input) };

  const command = String(input.command ?? "");
  const catastrophe = allowCatastrophic ? undefined : findMatch(command, catastrophicPatterns);
  const danger = findMatch(command, dangerousPatterns);
  const rmDanger = checkDangerousRmRf(command, process.cwd());

  if (catastrophe) return { icon: "🚫", description: `bash: ${command}\n   🚫 CATASTROPHIC: ${catastrophe.description}` };
  if (danger) return { icon: "⚠️", description: `bash: ${command}\n   ⚠️  DANGEROUS: ${danger.description}` };
  if (rmDanger) return { icon: "⚠️", description: `bash: ${command}\n   ⚠️  DANGEROUS: ${rmDanger.description}` };
  return { icon: "🔒", description: `bash: ${command}` };
}

function describeNonBashApprovalRequest(toolName: string, input: Record<string, unknown>): string {
  const parts = getApprovalInputParts(input);
  return parts.length > 0 ? `${toolName}: ${truncateApprovalDescription(parts.join(", "))}` : toolName;
}

function getApprovalInputParts(input: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const key of ["path", "paths", "file", "files", "glob", "pattern", "name"]) {
    const values: string[] = [];
    collectStringValues(input[key], values);
    if (values.length > 0) parts.push(`${key}=${values.join("|")}`);
  }
  return parts;
}

function truncateApprovalDescription(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}
