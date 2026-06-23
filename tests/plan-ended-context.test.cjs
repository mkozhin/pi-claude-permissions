const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const ts = require("typescript");

const TEST_HOME = "/tmp/pi-claude-permissions-home";

function loadExtension(options = {}) {
  const home = options.home ?? TEST_HOME;
  const configFiles = options.configFiles ?? {};
  const sourcePath = join(__dirname, "..", "extensions", "index.ts");
  const source = readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });

  const module = { exports: {} };
  const fn = new Function("require", "module", "exports", "__dirname", "__filename", outputText);
  fn(mockRequireForExtension(home, configFiles), module, module.exports, join(__dirname, "..", "extensions"), sourcePath);
  return module.exports.default;
}

function mockRequireForExtension(home, configFiles) {
  return (specifier) => {
    if (specifier === "node:os") {
      return { ...require("node:os"), homedir: () => home };
    }

    if (specifier === "node:fs/promises") {
      return {
        ...require("node:fs/promises"),
        readFile: async (path) => {
          const key = String(path);
          if (Object.prototype.hasOwnProperty.call(configFiles, key)) return configFiles[key];
          const error = new Error(`ENOENT: no such file or directory, open '${key}'`);
          error.code = "ENOENT";
          throw error;
        },
      };
    }

    return require(specifier);
  };
}

function buildConfigFiles(options, home) {
  const files = { ...(options.configFiles ?? {}) };
  const add = (path, value) => {
    if (value !== undefined) files[path] = JSON.stringify(value);
  };

  add(resolve(home, ".pi/agent/extensions/permissions.json"), options.globalConfig);
  add(resolve(process.cwd(), ".pi/extensions/permissions.json"), options.localConfig);
  add(resolve(home, ".pi/agent/settings.json"), options.globalSettings);
  add(resolve(process.cwd(), ".pi/settings.json"), options.localSettings);

  return files;
}

async function createHarness(options = {}) {
  const home = options.home ?? TEST_HOME;
  const selectResponses = [...(options.selectResponses ?? [])];
  const handlers = new Map();
  const shortcuts = new Map();
  const commands = new Map();
  const flags = new Map();
  let permissionStatus;
  let lastSelectOptions;
  let lastSelectPrompt;
  let selectCallCount = 0;
  let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  const pi = {
    events: { emit() {} },
    registerFlag(name, options) { flags.set(name, options.default); },
    getFlag(name) { return flags.get(name); },
    registerShortcut(shortcut, options) { shortcuts.set(shortcut, options); },
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(next) { activeTools = [...next]; },
  };

  const ctx = {
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? process.cwd(),
    ui: {
      notify() {},
      setStatus(name, value) {
        if (name === "permissions") permissionStatus = value;
      },
      select(prompt, selectOptions) {
        selectCallCount += 1;
        lastSelectPrompt = prompt;
        lastSelectOptions = selectOptions;
        const response = selectResponses.length > 0 ? selectResponses.shift() : undefined;
        return typeof response === "number" ? selectOptions[response] : response;
      },
    },
  };

  const extension = loadExtension({ home, configFiles: buildConfigFiles(options, home) });
  await extension(pi);

  async function emit(event, payload = {}) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx));
    }
    return results;
  }

  async function beforeAgentStart() {
    const [result] = await emit("before_agent_start", {});
    return result;
  }

  async function sessionStart() {
    await emit("session_start", { reason: "startup" });
  }

  async function shiftTab() {
    await shortcuts.get("shift+tab").handler(ctx);
  }

  async function permissionsCommand() {
    await commands.get("permissions").handler([], ctx);
  }

  async function toolCall(toolName, input = {}) {
    const [result] = await emit("tool_call", { toolName, input });
    return result;
  }

  return {
    beforeAgentStart,
    sessionStart,
    shiftTab,
    permissionsCommand,
    toolCall,
    setFlag(name, value) { flags.set(name, value); },
    status() { return permissionStatus; },
    shortcutDescription() { return shortcuts.get("shift+tab").description; },
    lastSelectOptions() { return lastSelectOptions; },
    lastSelectPrompt() { return lastSelectPrompt; },
    selectCallCount() { return selectCallCount; },
    home() { return home; },
  };
}

function assertCatastrophicBlock(result, label) {
  assert.equal(result?.block, true, `${label} should be blocked`);
  assert.match(result.reason, /Catastrophic command blocked/, `${label} should report catastrophic safety`);
}

function assertProtectedPathBlock(result, label) {
  assert.equal(result?.block, true, `${label} should be blocked`);
  assert.match(result.reason, /protected path/i, `${label} should report protected-path safety`);
  assert.match(result.reason, /cannot be overridden/i, `${label} should be non-overridable`);
}

async function testStrictModeCanBeSelectedByFlag() {
  const h = await createHarness();
  h.setFlag("permission-mode", "strict");

  await h.sessionStart();

  assert.equal(h.status(), "⏵! Strict");
}

async function testShiftTabCycleIncludesStrictWithoutReorderingExistingModes() {
  const h = await createHarness();
  await h.sessionStart();

  assert.ok(h.shortcutDescription().includes("Strict"));

  await h.shiftTab();
  assert.equal(h.status(), "⏸ Plan");

  await h.shiftTab();
  assert.equal(h.status(), "⏵⏵ Accept Edits");

  await h.shiftTab();
  assert.equal(h.status(), "⏵⏵⏵⏵ Bypass");

  await h.shiftTab();
  assert.equal(h.status(), "⏵! Strict");

  await h.shiftTab();
  assert.equal(h.status(), "⏵ Default");
}

async function testPermissionsCommandListsStrict() {
  const h = await createHarness();

  await h.permissionsCommand();

  assert.ok(
    h.lastSelectOptions().some((option) =>
      option.includes("Strict") && option.includes("Ask before almost every tool call"),
    ),
  );
}

async function testStrictPromptsForOrdinaryReadTools() {
  for (const toolName of ["read", "ls", "grep"]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "strict");
    await h.sessionStart();

    const result = await h.toolCall(toolName, toolName === "read" ? { path: "README.md" } : { path: "." });

    assert.equal(h.selectCallCount(), 1, `strict should prompt for ${toolName}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
    assert.equal(h.lastSelectPrompt(), `🔒 ${toolName}`);
  }
}

async function testDefaultAllowsOrdinaryReadToolsWithoutPrompt() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  for (const [toolName, input] of [
    ["read", { path: "README.md" }],
    ["ls", { path: "." }],
    ["grep", { pattern: "strict", path: "README.md" }],
    ["find", { path: ".", pattern: "*.ts" }],
    ["rg", { pattern: "strict", path: "." }],
    ["fd", { pattern: "README" }],
    ["bat", { path: "README.md" }],
    ["eza", { path: "." }],
  ]) {
    const result = await h.toolCall(toolName, input);
    assert.equal(result, undefined, `default should allow ${toolName}`);
  }

  assert.equal(h.selectCallCount(), 0, "default read allowlist should not invoke confirmation UI");
}

async function testDefaultAllowsSafeReadOnlyBashWithoutPrompt() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  for (const command of [
    "ls",
    "grep strict README.md",
    "grep rm README.md",
    "rg touch .",
    "cat README.md",
    "git status",
    "git diff",
  ]) {
    const result = await h.toolCall("bash", { command });
    assert.equal(result, undefined, `default should allow safe read-only bash: ${command}`);
  }

  assert.equal(h.selectCallCount(), 0, "default safe bash allowlist should not invoke confirmation UI");
}

async function testDefaultPromptsForUnsafeBashSyntax() {
  for (const command of [
    "cat README.md > out.txt",
    "grep strict README.md | tee out.txt",
    "find . -exec rm {} \\;",
    "find . -delete",
    "find . -fprint out.txt",
    "sort -o out.txt README.md",
    "git diff --output=out.patch",
    "sed -n 'w out.txt' README.md",
    "cat $(touch generated.txt)",
    "cat README.md; touch generated.txt",
    "cat README.md && touch generated.txt",
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall("bash", { command });

    assert.equal(h.selectCallCount(), 1, `default should prompt for unsafe bash: ${command}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, "User denied bash");
    assert.equal(h.lastSelectPrompt(), `🔒 bash: ${command}`);
  }
}

async function testDefaultPromptsForWritesEditsAndMutatingBash() {
  for (const [toolName, input] of [
    ["write", { path: "generated.txt" }],
    ["edit", { path: "README.md" }],
    ["bash", { command: "touch generated.txt" }],
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 1, `default should prompt for ${toolName}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
  }
}

async function testDefaultPromptsForSensitiveDirectReads() {
  for (const [toolName, input] of [
    ["read", { path: ".env" }],
    ["read", { path: ".env.local" }],
    ["read", { path: "~/.ssh/config" }],
    ["read", { path: ".aws/credentials" }],
    ["read", { path: ".npmrc" }],
    ["read", { path: ".netrc" }],
    ["read", { path: ".kube/config" }],
    ["read", { path: "config/token.txt" }],
    ["read", { path: "credentials.json" }],
    ["read", { path: "private-key.pem" }],
    ["read", { path: "auth.json" }],
    ["grep", { pattern: "needle", path: ".env" }],
    ["find", { path: ".aws" }],
    ["find", { path: ".", pattern: ".env" }],
    ["ls", { paths: ["README.md", "~/.ssh/config"] }],
    ["rg", { pattern: "needle", files: ["README.md", "credentials.json"] }],
    ["fd", { pattern: "credentials" }],
    ["bat", { file: ".npmrc" }],
    ["eza", { glob: "private-key.pem" }],
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 1, `default should prompt for sensitive ${toolName} input: ${JSON.stringify(input)}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
    assert.equal(h.lastSelectPrompt(), `🔒 ${toolName}`);
  }
}

async function testDefaultPromptsForImplicitSensitiveCwdReads() {
  for (const toolName of ["read", "grep", "find", "ls", "rg", "fd", "bat", "eza"]) {
    const h = await createHarness({ cwd: `${TEST_HOME}/.ssh` });
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall(toolName, {});

    assert.equal(h.selectCallCount(), 1, `default should prompt for ${toolName} with sensitive cwd`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
  }
}

async function testDefaultPromptsForSensitiveBashReads() {
  for (const command of [
    "cat .env",
    "cat .env.local",
    "cat .e\"nv\"",
    "cat $'.env'",
    "grep token .ssh/config",
    "find .aws -type f",
    "fd config .kube",
    "sed -n p .env",
    "awk pattern credentials.json",
    "jq . auth.json",
    "cat .aws/credentials",
    "cat credentials.json",
    "git diff .env",
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall("bash", { command });

    assert.equal(h.selectCallCount(), 1, `default should prompt for sensitive bash read: ${command}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, "User denied bash");
    assert.equal(h.lastSelectPrompt(), `🔒 bash: ${command}`);
  }
}

async function testDefaultAllowsOrdinaryDotPathReadsWithoutPrompt() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  for (const path of [
    ".gitignore",
    ".github/workflows/publish.yml",
    ".editorconfig",
  ]) {
    const result = await h.toolCall("read", { path });
    assert.equal(result, undefined, `default should allow ordinary dot path: ${path}`);
  }

  assert.equal(h.selectCallCount(), 0, "ordinary dot paths should not invoke confirmation UI");
}

async function testDefaultAllowsWorkflowToolsWithoutPrompt() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  for (const toolName of ["manage_todo_list", "ask_user"]) {
    const result = await h.toolCall(toolName, { operation: "test" });
    assert.equal(result, undefined, `default should allow workflow tool by name: ${toolName}`);
  }

  assert.equal(h.selectCallCount(), 0, "default workflow tool allowlist should not invoke confirmation UI");
}

async function testStrictPromptsForWorkflowTools() {
  for (const toolName of ["manage_todo_list", "ask_user"]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "strict");
    await h.sessionStart();

    const result = await h.toolCall(toolName, { operation: "test" });

    assert.equal(h.selectCallCount(), 1, `strict should prompt for workflow tool: ${toolName}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
    assert.equal(h.lastSelectPrompt(), `🔒 ${toolName}`);
  }
}

async function testCatastrophicBashRunsBeforeAllowBranches() {
  const customModeConfig = {
    customModes: [{
      id: "customAllow",
      label: "Custom Allow",
      status: "C",
      policy: { network: { allowLocalhostOnly: false } },
    }],
  };

  for (const testCase of [
    { label: "plan allow path", mode: "plan", command: "cat sudo mkfs" },
    { label: "plan deny path", mode: "plan", command: "sudo mkfs /dev/sda" },
    { label: "custom policy allow path", mode: "customAllow", command: "cat sudo mkfs", localConfig: customModeConfig },
    { label: "bypass allow path", mode: "bypassPermissions", command: "cat sudo mkfs" },
    { label: "default read allowlist path", mode: "default", command: "cat sudo mkfs" },
    { label: "strict prompt path", mode: "strict", command: "cat sudo mkfs" },
    { label: "plan critical rm path", mode: "plan", command: "rm -rf /" },
    { label: "custom policy critical rm path", mode: "customAllow", command: "rm -rf ~", localConfig: customModeConfig },
    { label: "bypass critical rm path", mode: "bypassPermissions", command: "sudo rm -rf /usr" },
    { label: "default critical rm path", mode: "default", command: "rm -rf /tmp" },
    { label: "strict critical rm path", mode: "strict", command: "rm -rf /var" },
  ]) {
    const h = await createHarness({ localConfig: testCase.localConfig });
    h.setFlag("permission-mode", testCase.mode);
    await h.sessionStart();

    const result = await h.toolCall("bash", { command: testCase.command });

    assertCatastrophicBlock(result, testCase.label);
    assert.equal(h.selectCallCount(), 0, `${testCase.label} should not prompt before catastrophic block`);
  }
}

async function testProtectedPathsRunBeforeAllowAndDenyBranches() {
  const customModeConfig = {
    customModes: [{
      id: "customAllow",
      label: "Custom Allow",
      status: "C",
      policy: { network: { allowLocalhostOnly: false } },
    }],
  };

  for (const testCase of [
    { label: "plan safe bash allow path", mode: "plan", toolName: "bash", input: { command: "cat ~/.ssh/config" } },
    { label: "plan write deny path", mode: "plan", toolName: "write", inputForHome: (home) => ({ path: `${home}/.ssh/config` }) },
    { label: "custom policy bash allow path", mode: "customAllow", toolName: "bash", input: { command: "cat ~/.ssh/config" }, localConfig: customModeConfig },
    { label: "custom policy write allow path", mode: "customAllow", toolName: "write", inputForHome: (home) => ({ path: `${home}/.ssh/config` }), localConfig: customModeConfig },
    { label: "bypass write allow path", mode: "bypassPermissions", toolName: "write", inputForHome: (home) => ({ path: `${home}/.ssh/config` }) },
    { label: "acceptEdits edit allow path", mode: "acceptEdits", toolName: "edit", inputForHome: (home) => ({ path: `${home}/.ssh/config` }) },
    { label: "default bash read allowlist path", mode: "default", toolName: "bash", input: { command: "cat ~/.ssh/config" } },
    { label: "bypass bash $HOME protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat $HOME/.ssh/config" } },
    { label: "strict bash ${HOME} protected path", mode: "strict", toolName: "bash", input: { command: "cat ${HOME}/.ssh/config" } },
    { label: "default bash quoted protected path", mode: "default", toolName: "bash", input: { command: "cat ~/\".ssh\"/config" } },
  ]) {
    const h = await createHarness({ localConfig: testCase.localConfig });
    h.setFlag("permission-mode", testCase.mode);
    await h.sessionStart();

    const input = testCase.inputForHome ? testCase.inputForHome(h.home()) : testCase.input;
    const result = await h.toolCall(testCase.toolName, input);

    assertProtectedPathBlock(result, testCase.label);
    assert.equal(h.selectCallCount(), 0, `${testCase.label} should not prompt before protected-path block`);
  }
}

async function testSessionApprovalsDoNotBypassProtectedPaths() {
  const h = await createHarness({ selectResponses: [1] });
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const approved = await h.toolCall("write", { path: "generated.txt" });
  assert.equal(approved, undefined, "initial write approval should pass");
  assert.equal(h.selectCallCount(), 1, "initial write should prompt once");

  const result = await h.toolCall("write", { path: `${h.home()}/.ssh/config` });

  assertProtectedPathBlock(result, "session-approved write");
  assert.equal(h.selectCallCount(), 1, "protected write should be blocked before another prompt");
}

async function testSessionApprovalsStillWorkAfterSafetyPasses() {
  const defaultTool = await createHarness({ selectResponses: [1] });
  defaultTool.setFlag("permission-mode", "default");
  await defaultTool.sessionStart();

  assert.equal(await defaultTool.toolCall("write", { path: "generated.txt" }), undefined);
  assert.equal(await defaultTool.toolCall("write", { path: "another-generated.txt" }), undefined);
  assert.equal(defaultTool.selectCallCount(), 1, "default tool session approval should suppress second prompt");

  const defaultCommand = await createHarness({ selectResponses: [1] });
  defaultCommand.setFlag("permission-mode", "default");
  await defaultCommand.sessionStart();

  assert.equal(await defaultCommand.toolCall("bash", { command: "touch generated.txt" }), undefined);
  assert.equal(await defaultCommand.toolCall("bash", { command: "touch generated.txt" }), undefined);
  assert.equal(defaultCommand.selectCallCount(), 1, "default command session approval should suppress second prompt");

  const strictTool = await createHarness({ selectResponses: [1] });
  strictTool.setFlag("permission-mode", "strict");
  await strictTool.sessionStart();

  assert.equal(await strictTool.toolCall("read", { path: "README.md" }), undefined);
  assert.equal(await strictTool.toolCall("read", { path: "package.json" }), undefined);
  assert.equal(strictTool.selectCallCount(), 1, "strict tool session approval should suppress second prompt");

  const strictCommand = await createHarness({ selectResponses: [1] });
  strictCommand.setFlag("permission-mode", "strict");
  await strictCommand.sessionStart();

  assert.equal(await strictCommand.toolCall("bash", { command: "touch strict-generated.txt" }), undefined);
  assert.equal(await strictCommand.toolCall("bash", { command: "touch strict-generated.txt" }), undefined);
  assert.equal(strictCommand.selectCallCount(), 1, "strict command session approval should suppress second prompt");
}

async function testPromptRequiredCallsBlockWithoutUi() {
  for (const [mode, toolName, input] of [
    ["default", "write", { path: "generated.txt" }],
    ["default", "bash", { command: "touch generated.txt" }],
    ["strict", "read", { path: "README.md" }],
  ]) {
    const h = await createHarness({ hasUI: false });
    h.setFlag("permission-mode", mode);
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 0, `${mode} ${toolName} should not prompt without UI`);
    assert.equal(result?.block, true);
    assert.match(result?.reason, /no UI for confirmation/);
  }
}

async function testCyclingThroughPlanDoesNotInjectEndedContext() {
  const h = await createHarness();
  await h.sessionStart();

  await h.shiftTab(); // default -> plan: plan context is pending, but no agent turn used it
  await h.shiftTab(); // plan -> acceptEdits
  await h.shiftTab(); // acceptEdits -> bypassPermissions
  await h.shiftTab(); // bypassPermissions -> strict
  await h.shiftTab(); // strict -> default

  const result = await h.beforeAgentStart();
  assert.equal(result, undefined, "cycling through plan without a plan turn must not inject [PLAN MODE ENDED]");
}

async function testLeavingAfterPlanTurnInjectsEndedContext() {
  const h = await createHarness();
  await h.sessionStart();

  await h.shiftTab(); // default -> plan
  const planContext = await h.beforeAgentStart();
  assert.equal(planContext?.message?.customType, "plan-mode-context");

  await h.shiftTab(); // plan -> acceptEdits after a real plan turn
  const result = await h.beforeAgentStart();
  assert.equal(result?.message?.customType, "plan-mode-ended-context");
}

(async () => {
  await testStrictModeCanBeSelectedByFlag();
  await testShiftTabCycleIncludesStrictWithoutReorderingExistingModes();
  await testPermissionsCommandListsStrict();
  await testStrictPromptsForOrdinaryReadTools();
  await testDefaultAllowsOrdinaryReadToolsWithoutPrompt();
  await testDefaultAllowsSafeReadOnlyBashWithoutPrompt();
  await testDefaultPromptsForUnsafeBashSyntax();
  await testDefaultPromptsForWritesEditsAndMutatingBash();
  await testDefaultPromptsForSensitiveDirectReads();
  await testDefaultPromptsForImplicitSensitiveCwdReads();
  await testDefaultPromptsForSensitiveBashReads();
  await testDefaultAllowsOrdinaryDotPathReadsWithoutPrompt();
  await testDefaultAllowsWorkflowToolsWithoutPrompt();
  await testStrictPromptsForWorkflowTools();
  await testCatastrophicBashRunsBeforeAllowBranches();
  await testProtectedPathsRunBeforeAllowAndDenyBranches();
  await testSessionApprovalsDoNotBypassProtectedPaths();
  await testSessionApprovalsStillWorkAfterSafetyPasses();
  await testPromptRequiredCallsBlockWithoutUi();
  await testCyclingThroughPlanDoesNotInjectEndedContext();
  await testLeavingAfterPlanTurnInjectsEndedContext();
  console.log("plan-ended-context tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
