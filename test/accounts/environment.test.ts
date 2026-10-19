import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import accountsExtension, { ACCOUNTS_STATUS_KEY, AccountStore, FAIL_CLOSED_API_KEY } from "../../src/accounts.js";
import { ACCOUNT_SELECTION_ENTRY_TYPE } from "../../src/session-selection.js";
import { InMemoryAccountStorageBackend } from "../../src/storage.js";
import { isolateAccountEnvironment } from "../isolate-account-environment.js";
import { createMockPi } from "../support.js";

import {
  createInteractiveAccountContext,
  createMockContext,
  createTestSessionManager,
  credential,
  fakeProvider,
  latestSessionSelections,
  runtimeHarness,
  startSessionAndWaitForCurrentProvider,
} from "./fixtures.js";

isolateAccountEnvironment();
beforeAll(() => initTheme("dark", false));

test("PI_ACCOUNT overrides each supported provider without persisting the override", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        anthropic: { active: "personal", accounts: { personal: credential("personal"), work: credential("work") } },
        "openai-codex": { accounts: { work: credential("codex-work") } },
        "github-copilot": { active: "personal", accounts: { personal: credential("copilot-personal") } },
      },
    });
    const providers = [fakeProvider("anthropic"), fakeProvider("openai-codex"), fakeProvider("github-copilot")];
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers });
    const { keys, registry } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    const { ctx, notifications, statuses } = createMockContext({
      sessionManager,
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      mode: "print",
      hasUI: false,
    });
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    assert.equal(keys.get("anthropic"), "access-work");
    assert.equal(statuses.get(ACCOUNTS_STATUS_KEY), "account:PI_ACCOUNT");
    await mock.events.get("model_select")?.[0]?.({ model: { provider: "openai-codex", id: "codex" } }, ctx);
    assert.equal(keys.get("openai-codex"), "access-codex-work");
    await mock.events.get("model_select")?.[0]?.({ model: { provider: "github-copilot", id: "allowed" } }, ctx);
    assert.equal(keys.get("github-copilot"), FAIL_CLOSED_API_KEY);
    assert.equal(
      notifications.some(({ message }) => message.includes("GitHub Copilot")),
      true,
    );
    assert.equal((await store.readProviderAsync("anthropic")).active, "personal");
    assert.equal((await store.readProviderAsync("github-copilot")).active, "personal");
    assert.equal(latestSessionSelections(sessionManager).anthropic, "personal");
    assert.equal(latestSessionSelections(sessionManager)["openai-codex"], null);
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);

    delete process.env.PI_ACCOUNT;
    await startSessionAndWaitForCurrentProvider(mock, ctx, { reason: "resume" });
    assert.equal(keys.get("anthropic"), "access-personal");
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT fails a missing current provider closed before a print-mode turn", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        anthropic: { active: "personal", accounts: { personal: credential("personal") } },
        "openai-codex": { active: "work", accounts: { work: credential("work") } },
      },
    });
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("openai-codex"), fakeProvider("anthropic")] });
    const { keys, registry } = runtimeHarness(mock);
    let aborts = 0;
    const { ctx, notifications } = createMockContext({
      sessionManager: createTestSessionManager(),
      modelRegistry: registry,
      model: { provider: "anthropic", id: "claude" },
      mode: "print",
      hasUI: false,
      abort: () => {
        aborts += 1;
      },
    });
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    await mock.events.get("turn_start")?.[0]?.({}, ctx);
    assert.equal(aborts, 1);
    assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
    assert.equal((await store.readProviderAsync("anthropic")).active, "personal");
    assert.equal(
      notifications.some(({ message }) => message.includes("OpenAI Codex")),
      false,
    );
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT overrides restored choices and stays process-local across reload", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("anthropic", () => ({
      active: "personal",
      accounts: { personal: credential("personal"), work: credential("work") },
    }));
    const providers = [fakeProvider("anthropic")];
    const sessionManager = createTestSessionManager();
    sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
      version: 1,
      sessionId: sessionManager.getSessionId(),
      providers: { anthropic: "personal" },
    });
    process.env.PI_ACCOUNT = "work";
    const first = createMockPi();
    accountsExtension(first.pi, { store, providers });
    const firstRuntime = runtimeHarness(first);
    const firstContext = createMockContext({
      sessionManager,
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: firstRuntime.registry,
    }).ctx;
    await startSessionAndWaitForCurrentProvider(first, firstContext);
    assert.equal(firstRuntime.keys.get("anthropic"), "access-work");
    assert.equal(latestSessionSelections(sessionManager).anthropic, "personal");
    await first.events.get("session_shutdown")?.[0]?.({}, firstContext);
    await startSessionAndWaitForCurrentProvider(first, firstContext, { reason: "reload" });
    assert.equal(firstRuntime.keys.get("anthropic"), "access-work");
    await first.events.get("session_shutdown")?.[0]?.({}, firstContext);

    delete process.env.PI_ACCOUNT;
    const next = createMockPi();
    accountsExtension(next.pi, { store, providers });
    const nextRuntime = runtimeHarness(next);
    const nextContext = createMockContext({
      sessionManager,
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: nextRuntime.registry,
    }).ctx;
    await startSessionAndWaitForCurrentProvider(next, nextContext, { reason: "resume" });
    assert.equal(nextRuntime.keys.get("anthropic"), "access-personal");
    await next.events.get("session_shutdown")?.[0]?.({}, nextContext);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT keeps a restricted-model error from revealing the environment-selected name", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("github-copilot", () => ({
      accounts: { work: credential("copilot", { availableModelIds: ["allowed"] }) },
    }));
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("github-copilot")] });
    const { keys, registry } = runtimeHarness(mock);
    let aborts = 0;
    const { ctx, notifications } = createMockContext({
      sessionManager: createTestSessionManager(),
      model: { provider: "github-copilot", id: "blocked" },
      modelRegistry: registry,
      abort: () => {
        aborts += 1;
      },
    });
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    await mock.events.get("turn_start")?.[0]?.({}, ctx);
    assert.equal(keys.get("github-copilot"), "access-copilot");
    assert.equal(aborts, 1);
    assert.ok(notifications.some(({ message }) => message.includes("blocked") && message.includes("PI_ACCOUNT")));
    assert.equal(
      notifications.some(({ message }) => message.includes('account "work"')),
      false,
    );
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT bypasses invalid saved session selections without repairing them", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("anthropic", () => ({
      active: "personal",
      accounts: { personal: credential("personal"), work: credential("work") },
    }));
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
    const { keys, registry } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
      version: 2,
      sessionId: sessionManager.getSessionId(),
      providers: { anthropic: "personal" },
    });
    const count = sessionManager.getEntries().length;
    const { ctx, notifications } = createMockContext({
      sessionManager,
      modelRegistry: registry,
      model: { provider: "anthropic", id: "claude" },
    });
    await startSessionAndWaitForCurrentProvider(mock, ctx, { reason: "resume" });
    assert.equal(keys.get("anthropic"), "access-work");
    assert.equal(sessionManager.getEntries().length, count);
    assert.ok(notifications.some(({ message }) => message.includes("invalid")));
    const menu = createInteractiveAccountContext({
      sessionManager,
      modelRegistry: registry,
      model: { provider: "anthropic", id: "claude" },
    });
    await mock.commands.get("accounts")?.handler("", menu.ctx);
    assert.match(menu.selectCalls[0]?.title ?? "", /PI_ACCOUNT remains effective/);
    assert.match(menu.selectCalls[0]?.title ?? "", /Anthropic: PI_ACCOUNT/);
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);

    delete process.env.PI_ACCOUNT;
    await startSessionAndWaitForCurrentProvider(mock, ctx, { reason: "resume" });
    assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT works if the underlying session snapshot cannot be written", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("anthropic", () => ({
      active: "personal",
      accounts: { personal: credential("personal"), work: credential("work") },
    }));
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
    const { keys, registry } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    sessionManager.appendCustomEntry = () => {
      throw new Error("session disk unavailable");
    };
    const { ctx, notifications } = createMockContext({
      sessionManager,
      modelRegistry: registry,
      model: { provider: "anthropic", id: "claude" },
    });
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    assert.equal(keys.get("anthropic"), "access-work");
    assert.equal(sessionManager.getEntries().length, 0);
    assert.ok(notifications.some(({ message }) => message.includes("PI_ACCOUNT")));
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT rejects invalid values rather than using a saved default", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    for (const value of ["", "default", "bad/../value", "bad\u001b[31m"]) {
      process.env.PI_ACCOUNT = value;
      const store = new AccountStore(new InMemoryAccountStorageBackend());
      await store.updateProvider("anthropic", () => ({
        active: "personal",
        accounts: { personal: credential("personal") },
      }));
      const mock = createMockPi();
      accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
      const { keys, registry } = runtimeHarness(mock);
      const { ctx, notifications } = createMockContext({
        sessionManager: createTestSessionManager(),
        model: { provider: "anthropic", id: "claude" },
        modelRegistry: registry,
      });
      await startSessionAndWaitForCurrentProvider(mock, ctx);
      assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
      assert.ok(notifications.some(({ message }) => message.includes("PI_ACCOUNT")));
      if (value.includes("/") || value.includes("\u001b")) {
        assert.equal(
          notifications.some(({ message }) => message.includes(value)),
          false,
        );
      }
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT is captured independently by concurrent sessions", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("anthropic", () => ({
      accounts: { work: credential("work"), personal: credential("personal") },
    }));
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
    const firstRuntime = runtimeHarness(mock);
    const secondRuntime = runtimeHarness(mock);
    const first = createMockContext({
      sessionManager: createTestSessionManager(),
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: firstRuntime.registry,
    }).ctx;
    const second = createMockContext({
      sessionManager: createTestSessionManager(),
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: secondRuntime.registry,
    }).ctx;
    process.env.PI_ACCOUNT = "work";
    await startSessionAndWaitForCurrentProvider(mock, first);
    process.env.PI_ACCOUNT = "personal";
    await startSessionAndWaitForCurrentProvider(mock, second);
    await mock.events.get("before_agent_start")?.[0]?.({}, first);
    assert.equal(firstRuntime.keys.get("anthropic"), "access-work");
    assert.equal(secondRuntime.keys.get("anthropic"), "access-personal");
    await mock.events.get("session_shutdown")?.[0]?.({}, second);
    await mock.events.get("session_shutdown")?.[0]?.({}, first);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("PI_ACCOUNT hides interactive switches and shows its effective source", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("anthropic", () => ({
      active: "personal",
      accounts: { work: credential("work"), personal: credential("personal") },
    }));
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
    const { keys, registry } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    const { ctx, selectCalls } = createInteractiveAccountContext({
      modelRegistry: registry,
      model: { provider: "anthropic", id: "claude" },
      sessionManager,
    });
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    await mock.commands.get("accounts")?.handler("", ctx);
    assert.match(selectCalls[0]?.title ?? "", /PI_ACCOUNT.*process override/);
    assert.doesNotMatch(selectCalls[0]?.title ?? "", /: work/);
    assert.equal(
      selectCalls[0]?.options.some((option) => option.startsWith("Switch")),
      false,
    );
    assert.equal(keys.get("anthropic"), "access-work");
    assert.equal(latestSessionSelections(sessionManager).anthropic, "personal");
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("login under PI_ACCOUNT saves a credential without changing the effective override or session snapshot", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("anthropic", () => ({
      active: "personal",
      accounts: { personal: credential("personal"), work: credential("work") },
    }));
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
    const { keys, registry } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    const { ctx, notifications } = createInteractiveAccountContext(
      { modelRegistry: registry, model: { provider: "anthropic", id: "claude" }, sessionManager },
      { selections: ["Login new account", "Anthropic"], inputs: ["extra"] },
    );
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    await mock.commands.get("accounts")?.handler("", ctx);
    assert.ok((await store.readProviderAsync("anthropic")).accounts.extra);
    assert.equal(keys.get("anthropic"), "access-work");
    assert.equal(latestSessionSelections(sessionManager).anthropic, "personal");
    assert.ok(notifications.some(({ message }) => message.includes("PI_ACCOUNT still controls")));
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("removing a different account under PI_ACCOUNT leaves the override active", async () => {
  const previous = process.env.PI_ACCOUNT;
  try {
    process.env.PI_ACCOUNT = "work";
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("anthropic", () => ({
      active: "personal",
      accounts: { personal: credential("personal"), work: credential("work") },
    }));
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
    const { keys, registry } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    const { ctx, notifications } = createInteractiveAccountContext(
      { modelRegistry: registry, model: { provider: "anthropic", id: "claude" }, sessionManager },
      { selections: ["Remove account", "Anthropic · personal"], confirms: [true] },
    );
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    await mock.commands.get("accounts")?.handler("", ctx);
    assert.equal(keys.get("anthropic"), "access-work");
    assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
    assert.equal(latestSessionSelections(sessionManager).anthropic, "personal");
    assert.ok(notifications.some(({ message }) => /Removed.*PI_ACCOUNT/iu.test(message)));
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});
