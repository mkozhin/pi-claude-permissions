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

async function testStrictModeCanBeSelectedByConfig() {
  for (const settingsKey of ["localSettings", "globalSettings"]) {
    const h = await createHarness({
      [settingsKey]: { piClaudePermissions: { defaultMode: "strict" } },
    });

    await h.sessionStart();

    assert.equal(h.status(), "⏵! Strict", `${settingsKey} defaultMode should select strict`);
  }
}

async function testConfiguredShiftTabCycleCanIncludeStrict() {
  const h = await createHarness({
    localSettings: { piClaudePermissions: { shiftTabOptions: ["strict", "default"] } },
  });
  await h.sessionStart();

  await h.shiftTab();
  assert.equal(h.status(), "⏵! Strict");

  await h.shiftTab();
  assert.equal(h.status(), "⏵ Default");
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
  const h = await createHarness({ selectResponses: [4] });

  await h.permissionsCommand();

  assert.ok(
    h.lastSelectOptions().some((option) =>
      option.includes("Strict") && option.includes("Ask before almost every tool call"),
    ),
  );
  assert.equal(h.status(), "⏵! Strict");

  const result = await h.toolCall("read", { path: "README.md" });
  assert.equal(h.selectCallCount(), 2, "strict selected from /permissions should prompt for reads");
  assert.equal(result?.block, true);
  assert.equal(result?.reason, "User denied read");
}

async function testStrictPromptsForOrdinaryReadTools() {
  for (const [toolName, input, prompt] of [
    ["read", { path: "README.md" }, "🔒 read: path=README.md"],
    ["ls", { path: "." }, "🔒 ls: path=."],
    ["grep", { pattern: "strict", path: "README.md" }, "🔒 grep: path=README.md, pattern=strict"],
    ["find", { path: ".", pattern: "*.ts" }, "🔒 find: path=., pattern=*.ts"],
    ["rg", { pattern: "strict", path: "." }, "🔒 rg: path=., pattern=strict"],
    ["fd", { pattern: "README" }, "🔒 fd: pattern=README"],
    ["bat", { path: "README.md" }, "🔒 bat: path=README.md"],
    ["eza", { path: "." }, "🔒 eza: path=."],
    ["bash", { command: "cat README.md" }, "🔒 bash: cat README.md"],
    ["bash", { command: "git status" }, "🔒 bash: git status"],
    ["bash", { command: "git diff" }, "🔒 bash: git diff"],
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "strict");
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 1, `strict should prompt for ${toolName}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
    assert.equal(h.lastSelectPrompt(), prompt);
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
    ["grep", { pattern: "strict", path: ".", glob: "*.ts" }],
    ["find", { path: ".", pattern: "*.ts" }],
    ["rg", { pattern: "strict", path: "README.md" }],
    ["rg", { pattern: "strict", path: ".", glob: "*.ts" }],
    ["fd", { pattern: "README" }],
    ["bat", { path: "README.md" }],
    ["eza", { path: "." }],
  ]) {
    const result = await h.toolCall(toolName, input);
    assert.equal(result, undefined, `default should allow ${toolName}`);
  }

  assert.equal(h.selectCallCount(), 0, "default read allowlist should not invoke confirmation UI");
}

async function testDefaultPromptsForMissingFileReadInputs() {
  for (const [toolName, input] of [
    ["read", {}],
    ["read", { path: "" }],
    ["read", { path: null }],
    ["read", { paths: [] }],
    ["bat", {}],
    ["bat", { file: "" }],
    ["bat", { file: null }],
    ["bat", { files: [] }],
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 1, `default should prompt for missing ${toolName} file input: ${JSON.stringify(input)}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
  }
}

async function testDefaultAllowsSafeReadOnlyBashWithoutPrompt() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  for (const command of [
    "ls",
    "grep strict README.md",
    "grep rm README.md",
    "rg touch README.md",
    "cat README.md",
    "cat README.md | grep pi",
    "cat README.md 2>/dev/null",
    "head -n 5 README.md",
    "wc -l README.md",
    "jq . package.json",
    "bat README.md",
    "bat --paging=never README.md",
    "eza .",
    "diff README.md package.json",
    "git status",
    "git branch --show-current",
    "git branch --all",
    "git remote -v",
    "git ls-files",
  ]) {
    const result = await h.toolCall("bash", { command });
    assert.equal(result, undefined, `default should allow safe read-only bash: ${command}`);
  }

  assert.equal(h.selectCallCount(), 0, "default safe bash allowlist should not invoke confirmation UI");
}

async function testDefaultPromptsForUnsafeBashSyntax() {
  for (const command of [
    "cat README.md > out.txt",
    "./cat README.md",
    "/tmp/git status",
    "scripts/rg token README.md",
    "grep strict README.md | tee out.txt",
    "find . -exec rm {} \\;",
    "find . -delete",
    "find . -fprint out.txt",
    "sort -o out.txt README.md",
    "less -o out.txt README.md",
    "tree -o out.txt .",
    "grep -R token .",
    "grep -R --include=.env token .",
    "grep -d recurse token .",
    "grep --directories=recurse token .",
    "grep --directories recurse token .",
    "grep -drecurse token .",
    "find .",
    "find . -type f",
    "find .aws -type f",
    "find ~ -name config",
    "find / -name README.md",
    "ls -Ra ~",
    "ls -R /",
    "eza -R ~",
    "tree ~",
    "du /",
    "rg token",
    "rg token .",
    "rg --hidden token .",
    "rg --files .",
    "rg --files .aws",
    "rg -g !*.env token",
    "git diff --output=out.patch",
    "git log --output=out.patch",
    "git show --output=out.patch HEAD",
    "diff -r . /tmp/snapshot",
    "diff --recursive README.md package.json",
    "git diff",
    "git diff .env",
    "git log",
    "git log -p",
    "git show HEAD",
    "git config --get user.email",
    "git config --get --file=.env foo.bar",
    "git status --pathspec-from-file=paths.txt",
    "git ls-files --exclude-from paths.txt",
    "GIT_EXTERNAL_DIFF=rm git diff",
    "GIT_PAGER=touch git log",
    "git checkout main",
    "file --files-from paths.txt",
    "file -fpaths.txt",
    "find -files0-from paths.txt -name README.md",
    "sed -n 'w out.txt' README.md",
    "sed -n p .env",
    "awk pattern credentials.json",
    "cat `touch generated.txt`",
    "cat $(touch generated.txt)",
    "cat README.md || touch generated.txt",
    "cat README.md\n touch generated.txt",
    "cat <(touch generated.txt)",
    "cat $PROJECT_SECRET",
    "cat README.md & touch generated.txt",
    "cat README.md; touch generated.txt",
    "cat README.md && touch generated.txt",
    "npm install left-pad",
    "python -c 'print(1)'",
    "fd -x rm",
    "fd -H README.md .",
    "fd -I README.md .",
    "fd -u README.md .",
    "fd",
    "fd .",
    "fd -e ts",
    "tail -f README.md",
    "tail -F README.md",
    "tail --follow README.md",
    "cat /dev/zero",
    "bat --pager=./pager README.md",
    "bat --paging=always README.md",
    "bat --paging=always --pager=./pager README.md",
    "bat --config-file=.batconfig README.md",
    "less README.md",
    "more README.md",
    "rg --pre ./script token .",
    "diff --output=out.patch README.md package.json",
    "wc --files0-from=paths.txt",
    "sort --files0-from=paths.txt README.md",
    "du --files0-from paths.txt",
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
    ["mcp", { server: "unlisted", tool: "call" }],
    ["browser", { action: "navigate" }],
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
    ["read", { path: ".gnupg/private-keys-v1.d/key" }],
    ["read", { path: ".gpg/keyring" }],
    ["read", { path: ".docker/config.json" }],
    ["read", { path: "*.env" }],
    ["read", { path: "config/token.txt" }],
    ["read", { path: "credentials.json" }],
    ["read", { path: "prod.secret.json" }],
    ["read", { path: "service.auth.json" }],
    ["read", { path: "aws.credentials.json" }],
    ["read", { path: "private-key.pem" }],
    ["read", { path: "id_rsa" }],
    ["read", { path: "id_ed25519.pub" }],
    ["read", { path: "auth.json" }],
    ["grep", { pattern: "needle", path: ".env" }],
    ["grep", { pattern: "needle", path: "." }],
    ["grep", { pattern: "needle", path: ".", glob: "!*.env" }],
    ["find", { path: ".aws" }],
    ["find", { path: ".", pattern: ".env" }],
    ["find", { path: ".", pattern: "*" }],
    ["find", { path: "/", pattern: "config" }],
    ["find", { path: "~", pattern: "config" }],
    ["find", { path: ".", name: "prod.secret.json" }],
    ["ls", { paths: ["README.md", "~/.ssh/config"] }],
    ["ls", { name: "credentials.json" }],
    ["rg", { pattern: "needle", files: ["README.md", "credentials.json"] }],
    ["rg", { pattern: "needle", path: "." }],
    ["rg", { pattern: "needle", path: ".", glob: "!*.env" }],
    ["rg", { pattern: "needle", path: ".", glob: "*" }],
    ["fd", { pattern: "credentials" }],
    ["fd", { name: "id_rsa" }],
    ["fd", { path: "/", pattern: "config" }],
    ["fd", { path: "~", pattern: "config" }],
    ["bat", { file: ".npmrc" }],
    ["eza", { glob: "private-key.pem" }],
    ["eza", { name: "service.auth.json" }],
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 1, `default should prompt for sensitive ${toolName} input: ${JSON.stringify(input)}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
    assert.match(h.lastSelectPrompt(), new RegExp(`^🔒 ${toolName}: `));
  }
}

async function testDefaultPromptsForProtectedDirectReads() {
  for (const [toolName, input] of [
    ["read", { path: "~/.bashrc" }],
    ["read", { path: "~//.bashrc" }],
    ["read", { path: "~/.profile" }],
    ["bat", { path: "~/.zshrc" }],
    ["ls", { paths: ["README.md", "~/.bashrc"] }],
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 1, `default should prompt for protected ${toolName} input: ${JSON.stringify(input)}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
    assert.match(h.lastSelectPrompt(), new RegExp(`^🔒 ${toolName}: `));
  }

  const customProtected = await createHarness({
    localConfig: { protectedPaths: ["~/workspace/protected"] },
  });
  customProtected.setFlag("permission-mode", "default");
  await customProtected.sessionStart();

  const customResult = await customProtected.toolCall("read", { path: "~/workspace/protected/config.json" });

  assert.equal(customProtected.selectCallCount(), 1, "default should prompt for configured protected read path");
  assert.equal(customResult?.block, true);
  assert.equal(customResult?.reason, "User denied read");
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
    "cat *.env",
    "grep token .ssh/config",
    "grep needle README.md --exclude-from=.ssh/config",
    "grep --regexp=token .env",
    "grep --file patterns.txt .env",
    "rg -g .env token README.md",
    "rg needle README.md --ignore-file=.ssh/config",
    "rg --regexp=token credentials.json",
    "find . -name .env",
    "find . -path .aws -type f",
    "fd config .kube",
    "fd README --search-path=.ssh",
    "fd README --base-directory=.ssh",
    "fd README --ignore-file=.ssh/config",
    "fd credentials .",
    "fd .env .",
    "jq . auth.json",
    "jq -f service.auth.json data.json",
    "cat .aws/credentials",
    "cat credentials.json",
    "cat prod.secret.json",
    "cat service.auth.json",
    "git status --pathspec-from-file=.env",
    "git ls-files --exclude-from=.env",
    "git ls-files --exclude-per-directory .env",
    "file --files-from=.env",
    "file -f.env",
    "find -files0-from .env -name README.md",
    "diff --from-file=.env README.md",
    "diff --to-file=.env README.md",
    "wc --files0-from=.env",
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

async function testDefaultPromptsForImplicitSensitiveBashCwdReads() {
  for (const command of ["ls", "eza", "git status"]) {
    const h = await createHarness({ cwd: `${TEST_HOME}/workspace/credentials` });
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall("bash", { command });

    assert.equal(h.selectCallCount(), 1, `default should prompt for bash cwd read: ${command}`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, "User denied bash");
    assert.equal(h.lastSelectPrompt(), `🔒 bash: ${command}`);
  }
}

async function testDefaultPromptsForBroadHomeBashTraversal() {
  for (const command of [
    "find . -name config",
    "find -name config",
    "du .",
    "fd README",
    "fd README .",
    "fd README --search-path=.",
  ]) {
    const h = await createHarness({ cwd: TEST_HOME });
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall("bash", { command });

    assert.equal(h.selectCallCount(), 1, `default should prompt for broad home traversal: ${command}`);
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
    { label: "bypass critical rm $HOME path", mode: "bypassPermissions", command: "rm -rf $HOME" },
    { label: "bypass critical rm ${HOME} path", mode: "bypassPermissions", command: "rm -rf ${HOME}" },
    { label: "bypass critical rm ${HOME:?} path", mode: "bypassPermissions", command: "rm -rf ${HOME:?}" },
    { label: "bypass critical rm semicolon separator path", mode: "bypassPermissions", command: "rm -rf /tmp; echo ok" },
    { label: "bypass critical rm pipe separator path", mode: "bypassPermissions", command: "rm -rf /tmp|cat" },
    { label: "bypass second rm semicolon critical path", mode: "bypassPermissions", command: "rm -rf ./build; rm -rf /" },
    { label: "bypass second rm and critical path", mode: "bypassPermissions", command: "rm -rf ./build && rm -rf /tmp" },
    { label: "bypass second rm pipe critical path", mode: "bypassPermissions", command: "rm -rf ./build | rm -rf /usr" },
    { label: "bypass long rm flags root path", mode: "bypassPermissions", command: "rm --recursive --force /" },
    { label: "bypass mixed rm flags critical path", mode: "bypassPermissions", command: "rm -r --force /usr" },
    { label: "bypass IFS-separated rm root path", mode: "bypassPermissions", command: "rm -rf${IFS}/" },
    { label: "bypass ANSI-C quoted rm root path", mode: "bypassPermissions", command: "rm -rf $'\\x2f'" },
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
    { label: "bypass write tilde protected path", mode: "bypassPermissions", toolName: "write", input: { path: "~/.ssh/config" } },
    { label: "bypass write tilde double-slash protected path", mode: "bypassPermissions", toolName: "write", input: { path: "~//.ssh/config" } },
    { label: "bypass write relative protected cwd", mode: "bypassPermissions", toolName: "write", input: { path: "config" }, cwdForHome: (home) => `${home}/.ssh` },
    { label: "acceptEdits edit allow path", mode: "acceptEdits", toolName: "edit", inputForHome: (home) => ({ path: `${home}/.ssh/config` }) },
    { label: "acceptEdits edit tilde double-slash protected path", mode: "acceptEdits", toolName: "edit", input: { path: "~//.ssh/config" } },
    { label: "acceptEdits edit relative protected cwd", mode: "acceptEdits", toolName: "edit", input: { path: "config" }, cwdForHome: (home) => `${home}/.ssh` },
    { label: "default bash read allowlist path", mode: "default", toolName: "bash", input: { command: "cat ~/.ssh/config" } },
    { label: "default bash tilde double-slash protected path", mode: "default", toolName: "bash", input: { command: "cat ~//.ssh/config" } },
    { label: "bypass bash named-user tilde protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat ~alice/.ssh/config" } },
    { label: "bypass bash named-user tilde double-slash protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat ~alice//.ssh/config" } },
    { label: "bypass bash $HOME protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat $HOME/.ssh/config" } },
    { label: "bypass bash normalized protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat $HOME/.config/../.ssh/config" } },
    { label: "bypass bash complex HOME protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat ${HOME:0:1}${HOME:1}/.ssh/config" } },
    { label: "bypass grep regexp protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "grep --regexp=token ~/.ssh/config" } },
    { label: "bypass grep exclude-from protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "grep needle README.md --exclude-from=.ssh/config" }, cwdForHome: (home) => home },
    { label: "bypass grep separated exclude-from protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "grep needle README.md --exclude-from .ssh/config" }, cwdForHome: (home) => home },
    { label: "bypass rg ignore-file protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "rg needle README.md --ignore-file=.ssh/config" }, cwdForHome: (home) => home },
    { label: "bypass rg separated ignore-file protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "rg needle README.md --ignore-file .ssh/config" }, cwdForHome: (home) => home },
    { label: "bypass rg files protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "rg --files ~/.ssh" } },
    { label: "bypass fd search-path protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "fd README --search-path=.ssh" }, cwdForHome: (home) => home },
    { label: "bypass fd separated search-path protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "fd README --search-path .ssh" }, cwdForHome: (home) => home },
    { label: "bypass fd base-directory protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "fd README --base-directory=.ssh" }, cwdForHome: (home) => home },
    { label: "bypass fd separated base-directory protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "fd README --base-directory .ssh" }, cwdForHome: (home) => home },
    { label: "bypass fd ignore-file protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "fd README --ignore-file=.ssh/config" }, cwdForHome: (home) => home },
    { label: "bypass fd separated ignore-file protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "fd README --ignore-file .ssh/config" }, cwdForHome: (home) => home },
    { label: "bypass find option protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "find -L ~/.ssh -type f" } },
    { label: "bypass find predicate protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "find ~ -path ~/.ssh -type f" } },
    { label: "bypass ssh attached config protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "ssh -F~/.ssh/config host" } },
    { label: "bypass git global protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "git --git-dir=~/.ssh status" } },
    { label: "bypass git separated git-dir protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "git --git-dir .ssh status" }, cwdForHome: (home) => home },
    { label: "bypass git separated work-tree protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "git --work-tree .ssh status" }, cwdForHome: (home) => home },
    { label: "bypass git separated -C protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "git -C .ssh status" }, cwdForHome: (home) => home },
    { label: "bypass git relative global protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "git --git-dir=.ssh status" }, cwdForHome: (home) => home },
    { label: "bypass git assignment protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "GIT_DIR=.ssh git status" }, cwdForHome: (home) => home },
    { label: "bypass git config file protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "git config --get --file=~/.ssh/config core.filemode" } },
    { label: "bypass bash HOME substring expansion protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat ${HOME:0:999}/.ssh/config" } },
    { label: "bypass bash assigned shell variable protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "D=.ssh cat ~/$D/config" } },
    { label: "strict bash ${HOME} protected path", mode: "strict", toolName: "bash", input: { command: "cat ${HOME}/.ssh/config" } },
    { label: "default bash quoted protected path", mode: "default", toolName: "bash", input: { command: "cat ~/\".ssh\"/config" } },
    { label: "default bash glob protected path", mode: "default", toolName: "bash", input: { command: "cat ~/.s[s]h/config" } },
    { label: "default bash question-glob protected path", mode: "default", toolName: "bash", input: { command: "cat ~/.s?h/config" } },
    { label: "default bash negated-class protected path", mode: "default", toolName: "bash", input: { command: "cat ~/.s[!x]h/config" } },
    { label: "default bash broad hidden-glob protected path", mode: "default", toolName: "bash", input: { command: "cat ~/.*/*" } },
    { label: "bypass bash command substitution protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat ~/$(printf .ssh)/config" } },
    { label: "bypass bash ANSI-C quoted protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "cat $HOME/$'\\x2essh'/config" } },
    { label: "bypass git status protected cwd", mode: "bypassPermissions", toolName: "bash", input: { command: "git status" }, cwdForHome: (home) => `${home}/.ssh` },
    { label: "default git status protected cwd", mode: "default", toolName: "bash", input: { command: "git status" }, cwdForHome: (home) => `${home}/.ssh` },
    { label: "bypass root protected write descendant", mode: "bypassPermissions", toolName: "write", input: { path: "/tmp/config" }, localConfig: { protectedPaths: ["/"] } },
    { label: "bypass root protected bash descendant", mode: "bypassPermissions", toolName: "bash", input: { command: "cat /tmp/config" }, localConfig: { protectedPaths: ["/"] } },
  ]) {
    const h = await createHarness({
      localConfig: testCase.localConfig,
      cwd: testCase.cwdForHome ? testCase.cwdForHome(TEST_HOME) : undefined,
    });
    h.setFlag("permission-mode", testCase.mode);
    await h.sessionStart();

    const input = testCase.inputForHome ? testCase.inputForHome(h.home()) : testCase.input;
    const result = await h.toolCall(testCase.toolName, input);

    assertProtectedPathBlock(result, testCase.label);
    assert.equal(h.selectCallCount(), 0, `${testCase.label} should not prompt before protected-path block`);
  }
}

async function testPlanModeRejectsChainedOrMutatingBashSegments() {
  for (const command of [
    "cat README.md && touch generated.txt",
    "cat README.md || touch generated.txt",
    "cat README.md; rm -rf ./generated",
    "cat README.md & touch generated.txt",
    "cat README.md | touch generated.txt",
    "curl -o generated.txt https://example.com/file",
    "curl -O https://example.com/file",
    "npm audit --fix",
    "sed -n w generated.txt README.md",
    "sed -n 'w out.txt' README.md",
    "find . -delete",
    "find . -exec rm {} \\;",
    "find . -fprint out.txt",
    "fd README . -x rm",
    "fd README . --exec rm",
    "sort -o out.txt README.md",
    "tree -o out.txt .",
    "less -o out.txt README.md",
    "diff --output=out.patch README.md package.json",
    "git diff --output=out.patch",
    "bat --pager=./pager README.md",
    "rg --pre ./script token .",
    "cat /dev/zero",
  ]) {
    const h = await createHarness();
    h.setFlag("permission-mode", "plan");
    await h.sessionStart();

    const result = await h.toolCall("bash", { command });

    assert.equal(result?.block, true, `plan mode should reject unsafe bash: ${command}`);
    assert.match(result?.reason, /plan mode/i);
    assert.equal(h.selectCallCount(), 0, "plan-mode bash rejection should not invoke confirmation UI");
  }

  const h = await createHarness();
  h.setFlag("permission-mode", "plan");
  await h.sessionStart();

  assert.equal(await h.toolCall("bash", { command: "cat README.md | grep pi" }), undefined, "plan mode should allow safe read-only pipelines");
}

async function testCustomModePolicyAppliesAfterSafetyPasses() {
  const customModeConfig = {
    customModes: [{
      id: "customPolicy",
      label: "Custom Policy",
      status: "C",
      policy: {
        allowedWriteRoots: ["cwd"],
        blockedBashPatterns: [{ pattern: "forbidden", description: "blocked by custom policy" }],
      },
    }],
  };

  const h = await createHarness({
    localConfig: customModeConfig,
    cwd: `${TEST_HOME}/workspace/project`,
  });
  h.setFlag("permission-mode", "customPolicy");
  await h.sessionStart();

  assert.equal(await h.toolCall("write", { path: "generated.txt" }), undefined, "custom mode should allow writes inside cwd");

  let result = await h.toolCall("write", { path: "../outside.txt" });
  assert.equal(result?.block, true, "custom mode should block writes outside allowed roots");
  assert.match(result?.reason, /outside allowed roots/);

  result = await h.toolCall("bash", { command: "echo forbidden" });
  assert.equal(result?.block, true, "custom mode should apply blocked bash patterns");
  assert.equal(result?.reason, "blocked by custom policy");
}

async function testCustomModeNetworkPolicyAppliesAfterSafetyPasses() {
  const customModeConfig = {
    customModes: [{
      id: "networkPolicy",
      label: "Network Policy",
      status: "N",
      policy: {
        network: { allowLocalhostOnly: true, allowedPorts: [3000] },
      },
    }],
  };

  const h = await createHarness({ localConfig: customModeConfig });
  h.setFlag("permission-mode", "networkPolicy");
  await h.sessionStart();

  assert.equal(await h.toolCall("bash", { command: "curl http://localhost:3000/health" }), undefined, "custom mode should allow configured localhost network access");

  const result = await h.toolCall("bash", { command: "curl https://example.com" });
  assert.equal(result?.block, true, "custom mode should block external network access");
  assert.match(result?.reason, /Network/);
}

async function testAllowCatastrophicTrueReachesNormalModeHandling() {
  for (const [label, options] of [
    ["local settings", { localSettings: { piClaudePermissions: { allowCatastrophic: true } } }],
    ["global settings", { globalSettings: { piClaudePermissions: { allowCatastrophic: true } } }],
  ]) {
    const h = await createHarness(options);
    h.setFlag("permission-mode", "bypassPermissions");
    await h.sessionStart();

    assert.equal(await h.toolCall("bash", { command: "rm -rf /tmp" }), undefined, `${label} allowCatastrophic should let catastrophic commands reach bypass handling`);
    assert.equal(await h.toolCall("bash", { command: "sudo mkfs /dev/sda" }), undefined, `${label} allowCatastrophic should let configured catastrophic patterns reach bypass handling`);

    const protectedResult = await h.toolCall("bash", { command: "rm -rf ~/.ssh" });
    assertProtectedPathBlock(protectedResult, `${label} allowCatastrophic protected path`);
  }
}

async function testConfiguredCatastrophicPatternsBlockWhenNotAllowed() {
  const h = await createHarness();
  h.setFlag("permission-mode", "bypassPermissions");
  await h.sessionStart();

  const result = await h.toolCall("bash", { command: "sudo mkfs /dev/sda" });

  assertCatastrophicBlock(result, "configured catastrophic pattern");
  assert.equal(h.selectCallCount(), 0, "configured catastrophic pattern should not prompt before blocking");
}

async function testDangerouslySkipPermissionsStillRunsAlwaysOnSafety() {
  const h = await createHarness();
  h.setFlag("dangerously-skip-permissions", true);
  await h.sessionStart();

  assert.equal(h.status(), "⏵⏵⏵⏵ Bypass");
  assert.equal(await h.toolCall("write", { path: "generated.txt" }), undefined, "dangerously skip flag should bypass ordinary prompts");
  assert.equal(h.selectCallCount(), 0, "dangerously skip flag should not prompt for ordinary operations");

  assertCatastrophicBlock(await h.toolCall("bash", { command: "rm -rf /" }), "dangerously skip catastrophic command");
  assertProtectedPathBlock(await h.toolCall("bash", { command: "cat ~/.ssh/config" }), "dangerously skip protected bash");
  assertProtectedPathBlock(await h.toolCall("write", { path: "~/.ssh/config" }), "dangerously skip protected write");
  assert.equal(h.selectCallCount(), 0, "dangerously skip safety blocks should not prompt");
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

  const differentDefaultCommand = await defaultCommand.toolCall("bash", { command: "touch another-generated.txt" });
  assert.equal(defaultCommand.selectCallCount(), 2, "different default bash command should prompt again");
  assert.equal(differentDefaultCommand?.block, true);
  assert.equal(differentDefaultCommand?.reason, "User denied bash");

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

async function testSessionApprovalsClearOnModeChange() {
  const h = await createHarness({ selectResponses: [1] });
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  assert.equal(await h.toolCall("write", { path: "generated.txt" }), undefined);
  assert.equal(h.selectCallCount(), 1, "initial write should prompt once");

  await h.shiftTab(); // default -> plan
  await h.shiftTab(); // plan -> acceptEdits
  await h.shiftTab(); // acceptEdits -> bypassPermissions
  await h.shiftTab(); // bypassPermissions -> strict

  const result = await h.toolCall("write", { path: "generated.txt" });

  assert.equal(h.selectCallCount(), 2, "write session approval should not survive mode changes");
  assert.equal(result?.block, true);
  assert.equal(result?.reason, "User denied write");
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

async function testDefaultPreapprovedCallsRunWithoutUi() {
  const h = await createHarness({ hasUI: false });
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  for (const [toolName, input] of [
    ["read", { path: "README.md" }],
    ["bash", { command: "ls" }],
    ["manage_todo_list", { operation: "test" }],
    ["ask_user", { question: "Continue?" }],
  ]) {
    const result = await h.toolCall(toolName, input);
    assert.equal(result, undefined, `default should allow preapproved ${toolName} without UI`);
  }

  assert.equal(h.selectCallCount(), 0, "preapproved no-UI calls should not invoke confirmation UI");
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
  await testStrictModeCanBeSelectedByConfig();
  await testConfiguredShiftTabCycleCanIncludeStrict();
  await testShiftTabCycleIncludesStrictWithoutReorderingExistingModes();
  await testPermissionsCommandListsStrict();
  await testStrictPromptsForOrdinaryReadTools();
  await testDefaultAllowsOrdinaryReadToolsWithoutPrompt();
  await testDefaultPromptsForMissingFileReadInputs();
  await testDefaultAllowsSafeReadOnlyBashWithoutPrompt();
  await testDefaultPromptsForUnsafeBashSyntax();
  await testDefaultPromptsForWritesEditsAndMutatingBash();
  await testDefaultPromptsForSensitiveDirectReads();
  await testDefaultPromptsForProtectedDirectReads();
  await testDefaultPromptsForImplicitSensitiveCwdReads();
  await testDefaultPromptsForSensitiveBashReads();
  await testDefaultPromptsForImplicitSensitiveBashCwdReads();
  await testDefaultPromptsForBroadHomeBashTraversal();
  await testDefaultAllowsOrdinaryDotPathReadsWithoutPrompt();
  await testDefaultAllowsWorkflowToolsWithoutPrompt();
  await testStrictPromptsForWorkflowTools();
  await testCatastrophicBashRunsBeforeAllowBranches();
  await testProtectedPathsRunBeforeAllowAndDenyBranches();
  await testPlanModeRejectsChainedOrMutatingBashSegments();
  await testCustomModePolicyAppliesAfterSafetyPasses();
  await testCustomModeNetworkPolicyAppliesAfterSafetyPasses();
  await testAllowCatastrophicTrueReachesNormalModeHandling();
  await testConfiguredCatastrophicPatternsBlockWhenNotAllowed();
  await testDangerouslySkipPermissionsStillRunsAlwaysOnSafety();
  await testSessionApprovalsDoNotBypassProtectedPaths();
  await testSessionApprovalsStillWorkAfterSafetyPasses();
  await testSessionApprovalsClearOnModeChange();
  await testPromptRequiredCallsBlockWithoutUi();
  await testDefaultPreapprovedCallsRunWithoutUi();
  await testCyclingThroughPlanDoesNotInjectEndedContext();
  await testLeavingAfterPlanTurnInjectsEndedContext();
  console.log("plan-ended-context tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
