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
        if (typeof response === "function") return response(selectOptions, prompt);
        return typeof response === "number" ? selectOptions[response] : response;
      },
      // Mocks `ctx.ui.custom()` for `promptApprovalChoice()` (extensions/index.ts). This
      // reconstructs `lastSelectPrompt`/`lastSelectOptions` by parsing the component's own
      // `render()` output text, then drives the resolution via real `component.handleInput()`
      // byte sequences (digit keys / Escape) rather than calling `done()` directly, so the
      // digit-key code path itself is exercised by every approval-flow test. This coupling
      // is intentional: the parsing regex below (`/^(?:→\s*)?\d+\.\s(.+)$/`) is tied to
      // `promptApprovalChoice()`'s exact "N. option" render format (with optional "→ "
      // highlight prefix) — if that render format changes, this mock must be updated in
      // lockstep, or it will silently stop matching.
      //
      // The title itself may be multi-line (`describeApprovalRequest()` embeds real "\n"
      // for dangerous/catastrophic bash descriptions, and unsafe-bash-syntax detection can
      // surface a command containing a literal newline). `promptApprovalChoice()`'s
      // `render()` splits the title on "\n" into one rendered line per title line, followed
      // by a blank separator line before the option lines. To reconstruct the *original*
      // title string exactly (matching what `ctx.ui.select()` used to receive as a single
      // `prompt` argument), every raw line up to — but not including — that first blank
      // line is treated as part of the title and rejoined with "\n".
      custom(factory) {
        const fakeTui = { requestRender() {} };
        const fakeTheme = { fg: (_name, text) => text, bold: (text) => text };
        let doneValue;
        let resolved = false;
        const done = (value) => {
          doneValue = value;
          resolved = true;
        };
        const component = factory(fakeTui, fakeTheme, {}, done);

        const lines = component.render(80);
        const blankIndex = lines.findIndex((l) => l.trim() === "");
        const titleLines = blankIndex >= 0 ? lines.slice(0, blankIndex) : lines;
        const optionLines = (blankIndex >= 0 ? lines.slice(blankIndex + 1) : [])
          .map((l) => l.replace(/^\s+|\s+$/g, ""))
          .filter(Boolean);
        selectCallCount += 1;
        lastSelectPrompt = titleLines.join("\n");
        lastSelectOptions = optionLines
          .map((l) => l.match(/^(?:→\s*)?\d+\.\s(.+)$/))
          .filter(Boolean)
          .map((m) => m[1]);

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
    // Exposes `ctx.ui` directly so tests can exercise `ctx.ui.custom()` in isolation
    // (e.g. to confirm the mock itself behaves correctly) without going through a real
    // `promptApproval()` call site.
    ui() { return ctx.ui; },
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
  const h = await createHarness({
    selectResponses: [(options) => options.find((option) => option.includes("Strict"))],
  });

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

  for (const command of ["find . -name README", "fd README ."]) {
    const h = await createHarness({
      cwd: `${TEST_HOME}/workspace`,
      localConfig: { protectedPaths: ["~/workspace/protected"] },
    });
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall("bash", { command });

    assert.equal(h.selectCallCount(), 1, `default should prompt before traversing a root containing a protected child: ${command}`);
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
    ["rg", { pattern: "needle", path: "/", glob: "*.ts" }],
    ["rg", { pattern: "needle", path: "~", glob: "*.ts" }],
    ["grep", { pattern: "needle", path: "/", glob: "*.ts" }],
    ["grep", { pattern: "needle", path: "~", glob: "*.ts" }],
    ["fd", { pattern: "credentials" }],
    ["fd", { name: "id_rsa" }],
    ["fd", { path: "/", pattern: "config" }],
    ["fd", { path: "~", pattern: "config" }],
    ["bat", { file: ".npmrc" }],
    ["ls", { path: "/" }],
    ["ls", { path: "~" }],
    ["eza", { path: "/" }],
    ["eza", { path: "~" }],
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

  for (const [toolName, input] of [
    ["grep", { pattern: "needle", path: ".", glob: "*.ts" }],
    ["rg", { pattern: "needle", path: ".", glob: "*.ts" }],
    ["find", { path: ".", pattern: "*.ts" }],
    ["fd", { path: ".", pattern: "README" }],
  ]) {
    const h = await createHarness({
      cwd: `${TEST_HOME}/workspace/project`,
      localConfig: { protectedPaths: [`${TEST_HOME}/workspace/project/private`] },
    });
    h.setFlag("permission-mode", "default");
    await h.sessionStart();

    const result = await h.toolCall(toolName, input);

    assert.equal(h.selectCallCount(), 1, `default should prompt when ${toolName} search root contains a protected path`);
    assert.equal(result?.block, true);
    assert.equal(result?.reason, `User denied ${toolName}`);
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
    "ls",
    "ls .",
    "eza .",
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
    { label: "bypass plain mkfs disk path", mode: "bypassPermissions", command: "mkfs /dev/sda" },
    { label: "bypass reordered dd disk write path", mode: "bypassPermissions", command: "dd of=/dev/sda if=/dev/zero" },
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
    { label: "bypass critical rm ${HOME substring} path", mode: "bypassPermissions", command: "rm -rf ${HOME:0:999}" },
    { label: "bypass critical rm unresolved default path", mode: "bypassPermissions", command: "rm -rf ${target:-/}" },
    { label: "bypass critical rm unresolved pwd path", mode: "bypassPermissions", command: "rm -rf $PWD" },
    { label: "bypass critical rm usr glob path", mode: "bypassPermissions", command: "rm -rf /usr/*" },
    { label: "bypass critical rm etc glob path", mode: "bypassPermissions", command: "rm -rf /etc/*" },
    { label: "bypass critical rm home glob path", mode: "bypassPermissions", command: "rm -rf ~/*" },
    { label: "bypass critical rm semicolon separator path", mode: "bypassPermissions", command: "rm -rf /tmp; echo ok" },
    { label: "bypass critical rm pipe separator path", mode: "bypassPermissions", command: "rm -rf /tmp|cat" },
    { label: "bypass second rm semicolon critical path", mode: "bypassPermissions", command: "rm -rf ./build; rm -rf /" },
    { label: "bypass second rm and critical path", mode: "bypassPermissions", command: "rm -rf ./build && rm -rf /tmp" },
    { label: "bypass second rm pipe critical path", mode: "bypassPermissions", command: "rm -rf ./build | rm -rf /usr" },
    { label: "bypass command substitution critical rm path", mode: "bypassPermissions", command: "echo $(rm -rf /)" },
    { label: "bypass backtick critical rm path", mode: "bypassPermissions", command: "echo `rm -rf /`" },
    { label: "bypass relative rm current home path", mode: "bypassPermissions", command: "rm -rf .", cwdForHome: (home) => home },
    { label: "bypass relative rm parent home path", mode: "bypassPermissions", command: "rm -rf ..", cwdForHome: (home) => `${home}/project` },
    { label: "bypass relative rm current root path", mode: "bypassPermissions", command: "rm -rf .", cwd: "/" },
    { label: "bypass relative rm parent usr path", mode: "bypassPermissions", command: "rm -rf ..", cwd: "/usr/local" },
    { label: "bypass long rm flags root path", mode: "bypassPermissions", command: "rm --recursive --force /" },
    { label: "bypass mixed rm flags critical path", mode: "bypassPermissions", command: "rm -r --force /usr" },
    { label: "bypass IFS-separated rm root path", mode: "bypassPermissions", command: "rm -rf${IFS}/" },
    { label: "bypass ANSI-C quoted rm root path", mode: "bypassPermissions", command: "rm -rf $'\\x2f'" },
    { label: "bypass dynamically constructed rm root path", mode: "bypassPermissions", command: "r$(printf m) -rf /" },
    { label: "default critical rm path", mode: "default", command: "rm -rf /tmp" },
    { label: "strict critical rm path", mode: "strict", command: "rm -rf /var" },
  ]) {
    const h = await createHarness({
      localConfig: testCase.localConfig,
      cwd: testCase.cwd ?? (testCase.cwdForHome ? testCase.cwdForHome(TEST_HOME) : undefined),
    });
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
    { label: "bypass python concatenated protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "python -c 'import os; open(os.path.expanduser(\"~\")+\"/.ssh/config\").read()'" } },
    { label: "bypass python dynamic slash protected path", mode: "bypassPermissions", toolName: "bash", input: { command: "python -c 'import os; open(os.environ[\"HOME\"]+chr(47)+\".ssh/config\").read()'" } },
    { label: "bypass git status protected cwd", mode: "bypassPermissions", toolName: "bash", input: { command: "git status" }, cwdForHome: (home) => `${home}/.ssh` },
    { label: "default git status protected cwd", mode: "default", toolName: "bash", input: { command: "git status" }, cwdForHome: (home) => `${home}/.ssh` },
    { label: "bypass find cwd contains protected child", mode: "bypassPermissions", toolName: "bash", input: { command: "find . -name README" }, cwdForHome: (home) => home },
    { label: "bypass fd cwd contains protected child", mode: "bypassPermissions", toolName: "bash", input: { command: "fd README ." }, cwdForHome: (home) => home },
    { label: "bypass recursive grep cwd contains protected child", mode: "bypassPermissions", toolName: "bash", input: { command: "grep -R token ." }, cwdForHome: (home) => home },
    { label: "bypass rg cwd contains protected child", mode: "bypassPermissions", toolName: "bash", input: { command: "rg token ." }, cwdForHome: (home) => home },
    { label: "bypass rg files cwd contains protected child", mode: "bypassPermissions", toolName: "bash", input: { command: "rg --files ." }, cwdForHome: (home) => home },
    { label: "bypass recursive ls cwd contains protected child", mode: "bypassPermissions", toolName: "bash", input: { command: "ls -R ." }, cwdForHome: (home) => home },
    { label: "default quoted custom protected path with spaces", mode: "default", toolName: "bash", input: { command: "cat \"~/Secret Dir/config\"" }, localConfig: { protectedPaths: ["~/Secret Dir"] } },
    { label: "strict escaped custom protected path with spaces", mode: "strict", toolName: "bash", input: { command: "cat ~/Secret\\ Dir/config" }, localConfig: { protectedPaths: ["~/Secret Dir"] } },
    { label: "bypass escaped custom protected path with spaces", mode: "bypassPermissions", toolName: "bash", input: { command: "cat ~/Secret\\ Dir/config" }, localConfig: { protectedPaths: ["~/Secret Dir"] } },
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
    "env touch generated.txt",
    "env -i touch generated.txt",
    "env bash -c 'touch generated.txt'",
    "awk 'BEGIN { system(\"touch generated.txt\") }'",
    "sed -n 'e touch generated.txt' README.md",
    "curl -o generated.txt https://example.com/file",
    "curl -O https://example.com/file",
    "curl -X POST https://example.com/resource",
    "curl --upload-file README.md https://example.com/upload",
    "gh api -X POST /repos/owner/repo/issues",
    "gh api --method DELETE /repos/owner/repo/issues/1",
    "gh api -f title=generated /repos/owner/repo/issues",
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
    "printenv",
    "echo $OPENAI_API_KEY",
    "printf %s $GH_TOKEN",
    "gh auth status --show-token",
    "gh auth status -t",
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
  assert.equal(await h.toolCall("bash", { command: "echo $HOME" }), undefined, "plan mode should allow HOME expansion");
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
    ["local permissions config", { localConfig: { allowCatastrophic: true } }],
    ["global permissions config", { globalConfig: { allowCatastrophic: true } }],
  ]) {
    const h = await createHarness(options);
    h.setFlag("permission-mode", "bypassPermissions");
    await h.sessionStart();

    assert.equal(await h.toolCall("bash", { command: "rm -rf /tmp" }), undefined, `${label} allowCatastrophic should let catastrophic commands reach bypass handling`);
    assert.equal(await h.toolCall("bash", { command: "sudo mkfs /dev/sda" }), undefined, `${label} allowCatastrophic should let configured catastrophic patterns reach bypass handling`);
    assert.equal(await h.toolCall("bash", { command: "mkfs /dev/sda" }), undefined, `${label} allowCatastrophic should let builtin disk checks reach bypass handling`);
    assert.equal(await h.toolCall("bash", { command: "dd of=/dev/sda if=/dev/zero" }), undefined, `${label} allowCatastrophic should let raw disk checks reach bypass handling`);
    assert.equal(await h.toolCall("bash", { command: "r$(printf m) -rf /" }), undefined, `${label} allowCatastrophic should let dynamic rm checks reach bypass handling`);

    const protectedResult = await h.toolCall("bash", { command: "rm -rf ~/.ssh" });
    assertProtectedPathBlock(protectedResult, `${label} allowCatastrophic protected path`);
  }
}

async function testConfiguredCatastrophicPatternsBlockWhenNotAllowed() {
  for (const [label, options] of [
    ["local permissions config", { localConfig: { catastrophicPatterns: [{ pattern: "nuke-prod", description: "custom local catastrophe" }] } }],
    ["global permissions config", { globalConfig: { catastrophicPatterns: [{ pattern: "nuke-prod", description: "custom global catastrophe" }] } }],
  ]) {
    const h = await createHarness(options);
    h.setFlag("permission-mode", "bypassPermissions");
    await h.sessionStart();

    const result = await h.toolCall("bash", { command: "echo nuke-prod" });

    assertCatastrophicBlock(result, `${label} configured catastrophic pattern`);
    assert.match(result.reason, /custom .* catastrophe/, `${label} should use configured catastrophic description`);
    assert.equal(h.selectCallCount(), 0, `${label} configured catastrophic pattern should not prompt before blocking`);
  }
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

// Mirrors the render()/handleInput() shape of `promptApprovalChoice()` in
// extensions/index.ts (digit instant-resolve, Up/Down move-with-wrap, Enter resolves
// highlighted, Escape resolves undefined, "→ " highlight prefix, "N. option" lines) so
// this test exercises the harness's `ctx.ui.custom()` mock against a realistic factory
// shape before Task 4 wires the real helper into `promptApproval()`.
function makeChoiceFactory(title, options) {
  return (tui, _theme, _kb, done) => {
    let selectedIndex = 0;

    function handleInput(data) {
      for (let i = 0; i < options.length && i < 9; i++) {
        if (data === String(i + 1)) {
          done(options[i]);
          return;
        }
      }
      if (data === "\x1b[A") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        tui.requestRender();
        return;
      }
      if (data === "\x1b[B") {
        selectedIndex = (selectedIndex + 1) % options.length;
        tui.requestRender();
        return;
      }
      if (data === "\r") {
        done(options[selectedIndex]);
        return;
      }
      if (data === "\x1b") {
        done(undefined);
        return;
      }
    }

    function render() {
      const lines = [...title.split("\n"), ""];
      options.forEach((opt, i) => {
        const prefix = i === selectedIndex ? "→ " : "  ";
        lines.push(`${prefix}${i + 1}. ${opt}`);
      });
      lines.push("", "↑↓ select • Enter confirm • 1-9 quick pick • Esc = Deny");
      return lines;
    }

    return { render, handleInput };
  };
}

async function testUiCustomMockDrivesDigitSelectionAndTracksPromptOptions() {
  const options = ["Allow once", "Allow for session", "Deny"];

  const digitCase = await createHarness({ selectResponses: [1] });
  const digitResult = await digitCase.ui().custom(makeChoiceFactory("🔒 bash: rm foo", options));
  assert.equal(digitResult, "Allow for session", "custom() mock should resolve digit-selected option via real handleInput");
  assert.equal(digitCase.lastSelectPrompt(), "🔒 bash: rm foo", "custom() mock should reconstruct prompt from render() output");
  assert.deepEqual(digitCase.lastSelectOptions(), options, "custom() mock should reconstruct options from render() output");
  assert.equal(digitCase.selectCallCount(), 1, "custom() mock should increment selectCallCount like select()");

  const escapeCase = await createHarness({ selectResponses: [undefined] });
  const escapeResult = await escapeCase.ui().custom(makeChoiceFactory("🔒 bash: rm foo", options));
  assert.equal(escapeResult, undefined, "custom() mock should resolve undefined for Escape response");

  const multiLineCase = await createHarness({ selectResponses: [0] });
  await multiLineCase.ui().custom(makeChoiceFactory("🔒 bash: rm foo\n   ⚠️  DANGEROUS: recursive delete", options));
  assert.equal(
    multiLineCase.lastSelectPrompt(),
    "🔒 bash: rm foo\n   ⚠️  DANGEROUS: recursive delete",
    "custom() mock should rejoin every rendered title line (up to the blank separator) to reconstruct the full multi-line prompt",
  );
}

// Task 5: focused tests for promptApprovalChoice()'s digit/arrow/escape/render-numbering
// behavior. The harness's `ctx.ui.custom()` mock always drives resolution via real
// `component.handleInput()` digit-key byte sequences (see createHarness above), so every
// end-to-end `toolCall()` test already exercises the digit path — this test makes that
// mapping (digit -> outcome) an explicit, direct assertion instead of an incidental one.
async function testDigitKeySelectionResolvesCorrespondingOptionOutcome() {
  // digit "1" -> "Allow once": approves this single call, does not persist.
  const allowOnce = await createHarness({ selectResponses: [0] });
  allowOnce.setFlag("permission-mode", "default");
  await allowOnce.sessionStart();

  assert.equal(await allowOnce.toolCall("write", { path: "generated.txt" }), undefined, "digit 1 (Allow once) should not block");
  assert.equal(allowOnce.selectCallCount(), 1, "digit 1 should resolve from a single prompt");

  const secondWrite = await allowOnce.toolCall("write", { path: "generated.txt" });
  assert.equal(allowOnce.selectCallCount(), 2, "Allow once must not suppress a later prompt for the same write");
  assert.equal(secondWrite?.block, true, "second write with no queued response defaults to Escape/Deny, proving no session allow was recorded");

  // digit "2" -> "Allow for session": approves this call and persists for repeats.
  const allowSession = await createHarness({ selectResponses: [1] });
  allowSession.setFlag("permission-mode", "default");
  await allowSession.sessionStart();

  assert.equal(await allowSession.toolCall("write", { path: "generated.txt" }), undefined, "digit 2 (Allow for session) should not block");
  assert.equal(await allowSession.toolCall("write", { path: "generated.txt" }), undefined, "digit 2 selection should suppress a repeat prompt");
  assert.equal(allowSession.selectCallCount(), 1, "digit 2 selection should persist across repeated calls without re-prompting");

  // digit "3" -> "Deny": blocks immediately with the standard user-denied reason.
  const deny = await createHarness({ selectResponses: [2] });
  deny.setFlag("permission-mode", "default");
  await deny.sessionStart();

  const denyResult = await deny.toolCall("write", { path: "generated.txt" });
  assert.equal(denyResult?.block, true, "digit 3 (Deny) should block");
  assert.equal(denyResult?.reason, "User denied write", "digit 3 (Deny) should report the standard user-denied reason");
  assert.equal(deny.selectCallCount(), 1, "digit 3 should resolve from a single prompt");
}

// Drives a directly-constructed component (via the `makeChoiceFactory()` mirror of
// `promptApprovalChoice()`, already used by Task 3's mock test) through a raw Up/Down/Enter
// byte sequence, bypassing the harness's digit-driven `custom()` mock entirely — this is the
// only way to exercise the non-digit arrow+Enter path end to end.
async function testArrowNavigationWrapsAndEnterResolvesHighlightedOption() {
  const options = ["Allow once", "Allow for session", "Deny"];
  let renderRequests = 0;
  const fakeTui = { requestRender() { renderRequests += 1; } };
  const fakeTheme = { fg: (_name, text) => text, bold: (text) => text };
  let doneValue;
  let resolved = false;
  const done = (value) => {
    doneValue = value;
    resolved = true;
  };
  const component = makeChoiceFactory("🔒 write: generated.txt", options)(fakeTui, fakeTheme, {}, done);

  // 3 options: Down Down Down wraps 0 -> 1 -> 2 -> 0.
  component.handleInput("\x1b[B");
  component.handleInput("\x1b[B");
  component.handleInput("\x1b[B");
  assert.equal(resolved, false, "arrow navigation alone must not resolve the dialog");

  // From index 0, Up wraps backward to the last option (index 2, "Deny").
  component.handleInput("\x1b[A");
  assert.equal(resolved, false, "arrow navigation alone must not resolve the dialog");
  assert.equal(renderRequests, 4, "each arrow keypress should request exactly one re-render");

  component.handleInput("\r"); // Enter confirms the highlighted option
  assert.equal(resolved, true, "Enter should resolve the dialog");
  assert.equal(doneValue, "Deny", "Enter should resolve the option highlighted after the Up/Down sequence");
}

// Proves a digit outside the option range is a pure no-op: the dialog stays open, done() is
// not called, and later input (Enter) still resolves correctly against the untouched
// selection state.
async function testDigitOutsideOptionRangeIsIgnored() {
  const options = ["Allow once", "Allow for session", "Deny"];
  const fakeTui = { requestRender() {} };
  const fakeTheme = { fg: (_name, text) => text, bold: (text) => text };
  let doneValue;
  let resolved = false;
  const done = (value) => {
    doneValue = value;
    resolved = true;
  };
  const component = makeChoiceFactory("🔒 write: generated.txt", options)(fakeTui, fakeTheme, {}, done);

  component.handleInput("9"); // out of range for a 3-option dialog
  assert.equal(resolved, false, "an out-of-range digit must not resolve the dialog");
  assert.equal(doneValue, undefined, "done() must not be called for an out-of-range digit");

  component.handleInput("\r");
  assert.equal(resolved, true, "Enter should still resolve normally after an ignored out-of-range digit");
  assert.equal(doneValue, "Allow once", "the ignored out-of-range digit must not have changed the highlighted selection");
}

// End-to-end: Escape resolves undefined from promptApprovalChoice(), and promptApproval()
// must treat that exactly like today's ctx.ui.select() cancel — a Deny block.
async function testEscapeResolvesUndefinedAndTreatedAsDeny() {
  const h = await createHarness({ selectResponses: [undefined] });
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const result = await h.toolCall("write", { path: "generated.txt" });

  assert.equal(result?.block, true, "Escape should be treated as Deny by promptApproval()");
  assert.equal(result?.reason, "User denied write", "Escape denial should report the standard user-denied reason");
  assert.equal(h.selectCallCount(), 1, "Escape should still resolve from a single prompt");
}

// Regression guard for the core visible feature: the rendered dialog actually contains
// numbered "N. option" lines with the correct option text.
async function testRenderedOutputContainsNumberedOptionLines() {
  const options = ["Allow once", "Allow for session", "Deny"];
  const fakeTui = { requestRender() {} };
  const fakeTheme = { fg: (_name, text) => text, bold: (text) => text };
  const component = makeChoiceFactory("🔒 write: generated.txt", options)(fakeTui, fakeTheme, {}, () => {});

  const lines = component.render(80);

  assert.ok(lines.some((line) => line.includes("1. Allow once")), "render output should contain a numbered line for option 1");
  assert.ok(lines.some((line) => line.includes("2. Allow for session")), "render output should contain a numbered line for option 2");
  assert.ok(lines.some((line) => line.includes("3. Deny")), "render output should contain a numbered line for option 3");
}

// Drives a *real* dangerous bash command through toolCall() and captures the actual
// `promptApprovalChoice()` factory from `extensions/index.ts` (not the `makeChoiceFactory()`
// mirror) by temporarily overriding the harness's `ctx.ui.custom()`. Guards the render bug
// found in plan review: `describeApprovalRequest()` embeds a real "\n" in the title for
// dangerous/catastrophic bash commands, and render() must split that into separate line
// entries rather than pushing one raw multi-line string.
async function testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const ui = h.ui();
  const originalCustom = ui.custom;
  let capturedLines;
  ui.custom = (factory) =>
    new Promise((resolvePromise) => {
      const fakeTui = { requestRender() {} };
      const fakeTheme = { fg: (_name, text) => text, bold: (text) => text };
      const component = factory(fakeTui, fakeTheme, {}, resolvePromise);
      capturedLines = component.render(80);
      component.handleInput("1"); // Allow once, so promptApproval() completes normally
    });

  let result;
  try {
    result = await h.toolCall("bash", { command: "chmod -R 777 /tmp/generated" });
  } finally {
    ui.custom = originalCustom;
  }

  assert.equal(result, undefined, "Allow once should not block the dangerous command");
  assert.ok(capturedLines, "the dangerous bash command should have reached promptApprovalChoice()'s custom() dialog");
  assert.ok(
    capturedLines.some((line) => line.includes("bash: chmod -R 777 /tmp/generated") && !line.includes("DANGEROUS")),
    "the command line should be its own render line, not merged with the warning line",
  );
  assert.ok(
    capturedLines.some((line) => line.includes("DANGEROUS") && line.includes("insecure recursive permissions")),
    "the DANGEROUS warning should be its own separate render line",
  );
  assert.ok(
    !capturedLines.some((line) => line.includes("\n")),
    "no single render line should contain an embedded newline — the multi-line title must be split",
  );
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
  await testUiCustomMockDrivesDigitSelectionAndTracksPromptOptions();
  await testDigitKeySelectionResolvesCorrespondingOptionOutcome();
  await testArrowNavigationWrapsAndEnterResolvesHighlightedOption();
  await testDigitOutsideOptionRangeIsIgnored();
  await testEscapeResolvesUndefinedAndTreatedAsDeny();
  await testRenderedOutputContainsNumberedOptionLines();
  await testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines();
  console.log("plan-ended-context tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
