const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const ts = require("typescript");
// Real KeybindingsManager/TUI_KEYBINDINGS from the same package promptApprovalChoice() itself
// imports (extensions/index.ts), so the fake `kb` handed to ctx.ui.custom()'s factory in this
// harness matches() exactly like the host's real KeybindingsManager instance would — including
// honoring remapped `tui.select.*` user bindings (see createFakeKeybindings below).
const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } = require("@earendil-works/pi-tui");

const TEST_HOME = "/tmp/pi-claude-permissions-home";

// userBindings (optional) lets a test remap a `tui.select.*` action (e.g. { "tui.select.confirm": "x" })
// to prove promptApprovalChoice() honors the real keybindings parameter rather than hard-coded keys.
function createFakeKeybindings(userBindings) {
  return new KeybindingsManager(TUI_KEYBINDINGS, userBindings);
}

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
  let selectMethodCallCount = 0;
  let customMethodCallCount = 0;
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
    // Defaults to "tui" so existing digit/arrow/escape-driven tests keep exercising
    // `promptApprovalChoice()`'s `ctx.ui.custom()` path unchanged. Pass `mode: "rpc"` (or
    // any non-"tui" value) to exercise the `ctx.ui.select()` fallback used when the host's
    // `custom()` isn't a real interactive dialog (see extensions/index.ts's UiContext).
    mode: options.mode ?? "tui",
    cwd: options.cwd ?? process.cwd(),
    ui: {
      notify() {},
      setStatus(name, value) {
        if (name === "permissions") permissionStatus = value;
      },
      select(prompt, selectOptions) {
        selectCallCount += 1;
        selectMethodCallCount += 1;
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
        const component = factory(fakeTui, fakeTheme, createFakeKeybindings(), done);

        const lines = component.render(80);
        const blankIndex = lines.findIndex((l) => l.trim() === "");
        const titleLines = blankIndex >= 0 ? lines.slice(0, blankIndex) : lines;
        const optionLines = (blankIndex >= 0 ? lines.slice(blankIndex + 1) : [])
          .map((l) => l.replace(/^\s+|\s+$/g, ""))
          .filter(Boolean);
        selectCallCount += 1;
        customMethodCallCount += 1;
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
    // Distinguishes which underlying `ctx.ui` method actually resolved the dialog — used to
    // prove `promptApprovalChoice()`'s TUI-vs-non-TUI routing (`ctx.mode !== "tui"` falls
    // back to `select()` instead of `custom()`), which `selectCallCount()` alone can't show
    // since both methods increment it identically.
    selectMethodCallCount() { return selectMethodCallCount; },
    customMethodCallCount() { return customMethodCallCount; },
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

// Mirrors promptApprovalChoice()'s render()/handleInput() shape; used only to validate the
// custom() mock itself in testUiCustomMockDrivesDigitSelectionAndTracksPromptOptions below.
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

// Captures the real promptApprovalChoice() factory (not the makeChoiceFactory() mirror) by
// temporarily overriding ctx.ui.custom(), drives it via drive(component, probe), then
// restores the mock and awaits h.toolCall(). probe exposes live counters for asserting
// intermediate state (e.g. that arrow keys alone never resolve the dialog). `kb` (optional)
// lets a test pass a KeybindingsManager with remapped user bindings — defaults to real
// TUI_KEYBINDINGS defaults, same as the host would build at startup.
async function withRealApprovalComponent(h, toolName, input, drive, kb = createFakeKeybindings()) {
  const ui = h.ui();
  const originalCustom = ui.custom;
  let capturedComponent;
  let renderRequests = 0;
  let doneCallCount = 0;
  let doneValue;

  ui.custom = (factory) =>
    new Promise((resolvePromise) => {
      const fakeTui = { requestRender() { renderRequests += 1; } };
      const fakeTheme = { fg: (_name, text) => text, bold: (text) => text };
      const done = (value) => {
        doneCallCount += 1;
        doneValue = value;
        resolvePromise(value);
      };
      capturedComponent = factory(fakeTui, fakeTheme, kb, done);
      const probe = {
        getRenderRequests: () => renderRequests,
        getDoneCallCount: () => doneCallCount,
        getDoneValue: () => doneValue,
      };
      drive(capturedComponent, probe);
    });

  let result;
  try {
    result = await h.toolCall(toolName, input);
  } finally {
    ui.custom = originalCustom;
  }

  return {
    result,
    component: capturedComponent,
    getRenderRequests: () => renderRequests,
    getDoneCallCount: () => doneCallCount,
    getDoneValue: () => doneValue,
  };
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

async function testArrowNavigationWrapsAndEnterResolvesHighlightedOption() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const capture = await withRealApprovalComponent(h, "write", { path: "generated.txt" }, (component, probe) => {
    // 3 options: Down Down Down wraps 0 -> 1 -> 2 -> 0.
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    assert.equal(probe.getDoneCallCount(), 0, "arrow navigation alone must not resolve the dialog");

    // From index 0, Up wraps backward to the last option (index 2, "Deny").
    component.handleInput("\x1b[A");
    assert.equal(probe.getDoneCallCount(), 0, "arrow navigation alone must not resolve the dialog");
    assert.equal(probe.getRenderRequests(), 4, "each arrow keypress should request exactly one re-render");

    component.handleInput("\r"); // Enter confirms the highlighted option
    assert.equal(probe.getDoneCallCount(), 1, "Enter should resolve the dialog exactly once");
  });

  assert.equal(capture.getDoneValue(), "Deny", "Enter should resolve the option highlighted after the Up/Down sequence");
  assert.equal(capture.result?.block, true, "resolving to the highlighted 'Deny' option should block the write");
  assert.equal(capture.result?.reason, "User denied write", "Deny should report the standard user-denied reason");
}

async function testDigitOutsideOptionRangeIsIgnored() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const capture = await withRealApprovalComponent(h, "write", { path: "generated.txt" }, (component, probe) => {
    component.handleInput("9"); // out of range for a 3-option dialog
    assert.equal(probe.getDoneCallCount(), 0, "an out-of-range digit must not resolve the dialog");

    component.handleInput("\r");
    assert.equal(probe.getDoneCallCount(), 1, "Enter should still resolve normally after an ignored out-of-range digit");
  });

  assert.equal(capture.getDoneValue(), "Allow once", "the ignored out-of-range digit must not have changed the highlighted selection");
  assert.equal(capture.result, undefined, "resolving to 'Allow once' should not block the write");
}

// Ctrl+C is part of the host's select() cancel binding (tui.select.cancel = ["escape", "ctrl+c"]).
async function testCtrlCResolvesUndefinedAndTreatedAsDeny() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const capture = await withRealApprovalComponent(h, "write", { path: "generated.txt" }, (component, probe) => {
    component.handleInput("\x03"); // Ctrl+C
    assert.equal(probe.getDoneCallCount(), 1, "Ctrl+C should resolve the dialog exactly once");
  });

  assert.equal(capture.getDoneValue(), undefined, "Ctrl+C should resolve undefined, matching Escape's cancel contract");
  assert.equal(capture.result?.block, true, "Ctrl+C should be treated as Deny by promptApproval()");
  assert.equal(capture.result?.reason, "User denied write", "Ctrl+C denial should report the standard user-denied reason");
}

// PageUp/PageDown were supported by the host's select() widget; jump to first/last option
// respectively rather than silently dropping the keys.
async function testPageUpPageDownJumpToFirstAndLastOption() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const capture = await withRealApprovalComponent(h, "write", { path: "generated.txt" }, (component, probe) => {
    component.handleInput("\x1b[6~"); // PageDown -> jumps to the last option ("Deny")
    assert.equal(probe.getDoneCallCount(), 0, "PageDown alone must not resolve the dialog");
    component.handleInput("\r");
    assert.equal(probe.getDoneCallCount(), 1);
  });
  assert.equal(capture.getDoneValue(), "Deny", "PageDown should highlight the last option");

  const capture2 = await withRealApprovalComponent(h, "write", { path: "generated.txt" }, (component, probe) => {
    component.handleInput("\x1b[6~"); // PageDown to the last option first
    component.handleInput("\x1b[5~"); // PageUp -> jumps back to the first option ("Allow once")
    assert.equal(probe.getDoneCallCount(), 0, "PageUp alone must not resolve the dialog");
    component.handleInput("\r");
  });
  assert.equal(capture2.getDoneValue(), "Allow once", "PageUp should highlight the first option");
}

// Proves promptApprovalChoice() consults the real `kb` parameter's kb.matches() rather than
// hard-coded Key.down/Key.enter byte comparisons: with "tui.select.down"/"tui.select.confirm"
// remapped, the default Down-arrow/Enter bytes must stop working and the remapped keys must work.
async function testRemappedKeybindingsAreHonoredForNavigationAndConfirm() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const remappedKb = createFakeKeybindings({ "tui.select.down": "n", "tui.select.confirm": "x" });
  const capture = await withRealApprovalComponent(
    h,
    "write",
    { path: "generated.txt" },
    (component, probe) => {
      component.handleInput("\x1b[B"); // default Down arrow must no longer navigate
      assert.equal(probe.getRenderRequests(), 0, "remapped tui.select.down must not respond to the default Down arrow");

      component.handleInput("n"); // remapped down key
      assert.equal(probe.getRenderRequests(), 1, "remapped tui.select.down key should navigate");

      component.handleInput("\r"); // default Enter byte must no longer confirm
      assert.equal(probe.getDoneCallCount(), 0, "remapped tui.select.confirm must not respond to the default Enter key");

      component.handleInput("x"); // remapped confirm key
      assert.equal(probe.getDoneCallCount(), 1, "remapped tui.select.confirm key should resolve the dialog");
    },
    remappedKb,
  );

  assert.equal(
    capture.getDoneValue(),
    "Allow all write for session",
    "remapped navigation+confirm should resolve the second (session-allow) option",
  );
  assert.equal(capture.result, undefined, "Allow-for-session should not block");
}

async function testEscapeResolvesUndefinedAndTreatedAsDeny() {
  const h = await createHarness({ selectResponses: [undefined] });
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const result = await h.toolCall("write", { path: "generated.txt" });

  assert.equal(result?.block, true, "Escape should be treated as Deny by promptApproval()");
  assert.equal(result?.reason, "User denied write", "Escape denial should report the standard user-denied reason");
  assert.equal(h.selectCallCount(), 1, "Escape should still resolve from a single prompt");
}

async function testRenderedOutputContainsNumberedOptionLines() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  let renderedLines;
  const capture = await withRealApprovalComponent(h, "write", { path: "generated.txt" }, (component) => {
    renderedLines = component.render(80);
    component.handleInput("1"); // resolve so h.toolCall() completes
  });
  assert.equal(capture.result, undefined, "Allow once should not block");

  assert.ok(renderedLines.some((line) => line.includes("1. Allow once")), "render output should contain a numbered line for option 1");
  assert.ok(renderedLines.some((line) => line.includes("2. Allow all write for session")), "render output should contain a numbered line for option 2");
  assert.ok(renderedLines.some((line) => line.includes("3. Deny")), "render output should contain a numbered line for option 3");
}

// describeApprovalRequest() embeds a real "\n" in the title for dangerous/catastrophic bash
// commands; render() must split that into separate line entries, not one raw multi-line string.
async function testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  let capturedLines;
  const capture = await withRealApprovalComponent(h, "bash", { command: "chmod -R 777 /tmp/generated" }, (component) => {
    capturedLines = component.render(80);
    component.handleInput("1"); // Allow once, so promptApproval() completes normally
  });

  assert.equal(capture.result, undefined, "Allow once should not block the dangerous command");
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

// RPC mode's real ctx.ui.custom() is a no-op stub that resolves undefined immediately
// without consulting the client, so promptApprovalChoice() must fall back to ctx.ui.select()
// whenever ctx.mode !== "tui" or every RPC approval prompt would be silently auto-denied.
async function testRpcModeFallsBackToSelectInsteadOfCustom() {
  const h = await createHarness({ mode: "rpc", selectResponses: [1] });
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const result = await h.toolCall("write", { path: "generated.txt" });

  assert.equal(result, undefined, "digit-2-equivalent select() response (Allow for session) should not block");
  assert.equal(h.customMethodCallCount(), 0, "RPC mode must never call ctx.ui.custom() for approval prompts");
  assert.equal(h.selectMethodCallCount(), 1, "RPC mode must resolve the approval prompt via ctx.ui.select()");
  assert.deepEqual(
    h.lastSelectOptions(),
    ["Allow once", "Allow all write for session", "Deny"],
    "the select() fallback must receive the same options the custom() dialog would have shown",
  );

  // The session-allow granted above should still suppress a repeat prompt, proving the
  // select()-fallback path integrates with the rest of promptApproval() unchanged.
  const repeat = await h.toolCall("write", { path: "generated.txt" });
  assert.equal(repeat, undefined, "session allow recorded via the select() fallback should suppress a repeat prompt");
  assert.equal(h.selectMethodCallCount(), 1, "the repeat write should not re-prompt");
}

async function testTuiModeStillUsesCustomDialog() {
  const h = await createHarness({ selectResponses: [0] });
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const result = await h.toolCall("write", { path: "generated.txt" });

  assert.equal(result, undefined, "Allow once should not block");
  assert.equal(h.customMethodCallCount(), 1, "TUI mode must resolve the approval prompt via ctx.ui.custom()");
  assert.equal(h.selectMethodCallCount(), 0, "TUI mode must never fall back to ctx.ui.select() for approval prompts");
}

// render(width) must truncate every line to fit width, across a range of widths including
// degenerate ones (0-4) where a naive ellipsis-always-inserted implementation would overflow
// even though the truncation budget collapses to zero.
async function testRenderTruncatesLongLinesToFitWidth() {
  const h = await createHarness();
  // "strict" mode (not "default") is required here: "echo" is on the default-mode safe-bash
  // allowlist, so under "default" this command would be preapproved without ever reaching
  // ctx.ui.custom() — "strict" forces confirmation regardless of command content, which is what
  // this test needs to exercise render()'s truncation.
  h.setFlag("permission-mode", "strict");
  await h.sessionStart();

  const widths = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 80];
  const renderedByWidth = {};
  const capture = await withRealApprovalComponent(h, "bash", { command: "echo " + "x".repeat(400) }, (component) => {
    for (const w of widths) {
      renderedByWidth[w] = component.render(w);
    }
    component.handleInput("1"); // resolve so h.toolCall() completes
  });
  assert.equal(capture.result, undefined, "Allow once should not block");

  for (const w of widths) {
    // A negative or zero width has no positive-width solution — truncateLineMiddle's
    // maxWidth <= 0 guard collapses those lines to "" (visibleWidth 0), which is the closest
    // achievable bound. Math.max(w, 0) captures that without changing the assertion's intent
    // for every non-degenerate width in the array.
    const bound = Math.max(w, 0);
    for (const line of renderedByWidth[w]) {
      assert.ok(
        visibleWidth(line) <= bound,
        `render(${w}) produced a line wider than ${bound}: visibleWidth=${visibleWidth(line)} line=${JSON.stringify(line)}`,
      );
    }
  }
}

// Proves middle-truncation genuinely elides the middle: a long bash command carries three
// distinct markers (start, middle, end); the start/end markers must survive in some rendered
// line while the middle marker must never appear in any rendered line.
async function testLongBashCommandTruncationPreservesHeadAndTail() {
  const h = await createHarness();
  // "strict" mode, for the same reason as testRenderTruncatesLongLinesToFitWidth: this command
  // starts with "echo" (default-mode safe-bash allowlist), so "default" would preapprove it
  // without ever reaching ctx.ui.custom().
  h.setFlag("permission-mode", "strict");
  await h.sessionStart();

  const command = "echo START_MARKER_" + "x".repeat(140) + "_MIDDLE_MARKER_" + "x".repeat(140) + "_END_MARKER";
  let capturedLines;
  const capture = await withRealApprovalComponent(h, "bash", { command }, (component) => {
    capturedLines = component.render(80);
    component.handleInput("1"); // resolve so h.toolCall() completes
  });
  assert.equal(capture.result, undefined, "Allow once should not block");

  assert.ok(
    capturedLines.some((line) => line.includes("START_MARKER") && line.includes("END_MARKER")),
    "some rendered line should preserve both the start and end markers",
  );
  assert.ok(
    !capturedLines.some((line) => line.includes("MIDDLE_MARKER")),
    "no rendered line should contain the middle marker — it must be elided",
  );
}

// Combines the two security-relevant scenarios that the standalone tests each cover only
// halfway: testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines uses a short dangerous
// command that never reaches truncation, and testLongBashCommandTruncationPreservesHeadAndTail
// uses a plain "echo" command that never matches DEFAULT_DANGEROUS. This test drives a command
// that actually matches DEFAULT_DANGEROUS ("chmod -R 777"), is long enough to force truncation,
// and carries head/tail markers — proving describeApprovalRequest()'s two-line "DANGEROUS" title
// survives render()'s truncation with both the warning and the dangerous command's visible
// start/end intact.
async function testDangerousLongBashCommandPreservesWarningAndHeadTail() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const command = "chmod -R 777 START_MARKER_" + "x".repeat(140) + "_END_MARKER";
  let capturedLines;
  const capture = await withRealApprovalComponent(h, "bash", { command }, (component) => {
    capturedLines = component.render(80);
    component.handleInput("1"); // resolve so h.toolCall() completes
  });
  assert.equal(capture.result, undefined, "Allow once should not block");

  for (const line of capturedLines) {
    assert.ok(
      visibleWidth(line) <= 80,
      `render(80) produced a line wider than 80: visibleWidth=${visibleWidth(line)} line=${JSON.stringify(line)}`,
    );
  }
  assert.ok(
    capturedLines.some((line) => line.includes("START_MARKER") && line.includes("END_MARKER")),
    "the truncated dangerous command line should preserve both the start and end markers",
  );
  assert.ok(
    capturedLines.some((line) => line.includes("DANGEROUS") && line.includes("insecure recursive permissions")),
    "the DANGEROUS warning must remain visible as its own line alongside the truncated command",
  );
  assert.ok(
    !capturedLines.some((line) => line.includes("\n")),
    "no single render line should contain an embedded newline even when the command is truncated",
  );
}

// Backs the acceptance claim that truncation covers non-bash content sources too (edit's
// long `path`), not just bash commands.
async function testLongEditPathTruncatesToFitWidth() {
  const h = await createHarness();
  h.setFlag("permission-mode", "default");
  await h.sessionStart();

  const path = "/very/deeply/nested/START_HEAD/" + "segment/".repeat(30) + "file.ts";
  let capturedLines;
  const capture = await withRealApprovalComponent(h, "edit", { path }, (component) => {
    capturedLines = component.render(80);
    component.handleInput("1"); // resolve so h.toolCall() completes
  });
  assert.equal(capture.result, undefined, "Allow once should not block");

  for (const line of capturedLines) {
    assert.ok(
      visibleWidth(line) <= 80,
      `render(80) produced a line wider than 80: visibleWidth=${visibleWidth(line)} line=${JSON.stringify(line)}`,
    );
  }
  // Width-only assertions can pass even if truncation silently drops the filename entirely —
  // mirror the bash sibling test by also asserting the recognizable head and tail survive.
  assert.ok(
    capturedLines.some((line) => line.includes("START_HEAD")),
    "some rendered line should preserve the start of the path",
  );
  assert.ok(
    capturedLines.some((line) => line.includes("file.ts")),
    "some rendered line should preserve the tail filename",
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
  await testCtrlCResolvesUndefinedAndTreatedAsDeny();
  await testPageUpPageDownJumpToFirstAndLastOption();
  await testRemappedKeybindingsAreHonoredForNavigationAndConfirm();
  await testEscapeResolvesUndefinedAndTreatedAsDeny();
  await testRenderedOutputContainsNumberedOptionLines();
  await testDangerousBashMultiLineTitleSplitsIntoSeparateRenderLines();
  await testRpcModeFallsBackToSelectInsteadOfCustom();
  await testTuiModeStillUsesCustomDialog();
  await testRenderTruncatesLongLinesToFitWidth();
  await testLongBashCommandTruncationPreservesHeadAndTail();
  await testDangerousLongBashCommandPreservesWarningAndHeadTail();
  await testLongEditPathTruncatesToFitWidth();
  console.log("plan-ended-context tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
