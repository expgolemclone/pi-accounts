import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import accountsExtension, { ACCOUNTS_STATUS_KEY, AccountStore, FAIL_CLOSED_API_KEY } from "../../src/accounts.js";
import { OAUTH_CREDENTIAL_READINESS_CHANNEL } from "../../src/oauth-credential-source.js";
import { RuntimeAuthCoordinator } from "../../src/runtime-auth.js";
import { ACCOUNT_SELECTION_ENTRY_TYPE } from "../../src/session-selection.js";
import { InMemoryAccountStorageBackend } from "../../src/storage.js";
import { isolateAccountEnvironment } from "../isolate-account-environment.js";
import { createMockPi } from "../support.js";

import {
  collectCredentialOffers,
  createInteractiveAccountContext,
  createMockContext,
  createTestSessionManager,
  credential,
  ensureStoredSelection,
  fakeProvider,
  latestSessionSelections,
  runtimeHarness,
  startSessionAndWaitForCurrentProvider,
  waitForTest,
} from "./fixtures.js";

isolateAccountEnvironment();
beforeAll(() => initTheme("dark", false));

test("default account menu seeds new sessions but leaves current and resumed selections unchanged", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const mock = createMockPi();
  const providers = [fakeProvider("anthropic"), fakeProvider("openai-codex")];
  accountsExtension(mock.pi, { store, providers });
  const runtime = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const current = createInteractiveAccountContext(
    {
      sessionManager,
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: runtime.registry,
    },
    { selections: ["Set default account", "Anthropic", "beta"] },
  );
  await startSessionAndWaitForCurrentProvider(mock, current.ctx);
  const entriesBefore = sessionManager.getEntries().length;
  await mock.commands.get("accounts")?.handler("", current.ctx);
  assert.equal((await store.readProviderAsync("anthropic")).active, "beta");
  assert.equal((await store.readProviderAsync("openai-codex")).active, "work");
  assert.equal(runtime.keys.get("anthropic"), "access-alpha");
  assert.equal(sessionManager.getEntries().length, entriesBefore);
  assert.match(current.notifications.at(-1)?.message ?? "", /new sessions: beta.*unchanged/);

  for (const reason of ["reload", "resume"]) {
    await mock.events.get("session_shutdown")?.[0]?.({ reason }, current.ctx);
    await startSessionAndWaitForCurrentProvider(mock, current.ctx, { reason });
    assert.equal(runtime.keys.get("anthropic"), "access-alpha");
  }
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);

  // A fresh extension instance represents a restarted Pi process; copied entries model forks.
  for (const copiedEntries of [false, true]) {
    const restarted = createMockPi();
    accountsExtension(restarted.pi, { store, providers });
    const nextRuntime = runtimeHarness(restarted);
    const nextSession = createTestSessionManager();
    if (copiedEntries) {
      for (const entry of sessionManager.getEntries()) {
        if (entry.type === "custom") nextSession.appendCustomEntry(entry.customType, entry.data);
      }
    }
    const next = createMockContext({
      sessionManager: nextSession,
      modelRegistry: nextRuntime.registry,
    });
    await startSessionAndWaitForCurrentProvider(restarted, next.ctx);
    await waitForTest(() => nextRuntime.keys.get("anthropic") === "access-beta");
    assert.equal(nextRuntime.keys.get("anthropic"), "access-beta");
    assert.equal(latestSessionSelections(nextSession).anthropic, "beta");
    await restarted.events.get("session_shutdown")?.[0]?.({}, next.ctx);
  }
});

test("removing an environment-selected account immediately fails closed without changing defaults", async () => {
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
      { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
    );
    await startSessionAndWaitForCurrentProvider(mock, ctx);
    await mock.commands.get("accounts")?.handler("", ctx);
    assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
    assert.equal((await store.readProviderAsync("anthropic")).active, "personal");
    assert.equal(latestSessionSelections(sessionManager).anthropic, "personal");
    assert.ok(notifications.some(({ message }) => /PI_ACCOUNT.*fail closed/iu.test(message)));
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_ACCOUNT;
    else process.env.PI_ACCOUNT = previous;
  }
});

test("clearing a startup default keeps the named account active only in the current session", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "work",
    accounts: { work: credential("work") },
  }));
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
  const runtime = runtimeHarness(mock);
  const current = createInteractiveAccountContext(
    { modelRegistry: runtime.registry, model: { provider: "anthropic", id: "claude" } },
    { selections: ["Set default account", "Anthropic", "Pi built-in login"] },
  );
  await startSessionAndWaitForCurrentProvider(mock, current.ctx);
  await mock.commands.get("accounts")?.handler("", current.ctx);
  assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
  assert.ok((await store.readProviderAsync("anthropic")).accounts.work);
  assert.equal(runtime.keys.get("anthropic"), "access-work");
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
  const nextSession = createTestSessionManager();
  const next = createMockContext({
    sessionManager: nextSession,
    modelRegistry: runtime.registry,
  });
  await startSessionAndWaitForCurrentProvider(mock, next.ctx);
  assert.equal(latestSessionSelections(nextSession).anthropic, null);
  assert.equal(runtime.keys.get("anthropic"), undefined);
  await mock.events.get("session_shutdown")?.[0]?.({}, next.ctx);
});

test("removing the configured default clears it without changing another session selection", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "alpha",
    accounts: { alpha: credential("alpha"), beta: credential("beta") },
  }));
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
  const runtime = runtimeHarness(mock);
  const current = createInteractiveAccountContext(
    { modelRegistry: runtime.registry, model: { provider: "anthropic", id: "claude" } },
    {
      selections: ["Set default account", "Anthropic", "beta", "Remove account", "Anthropic · beta"],
      confirms: [true],
    },
  );
  await mock.events.get("session_start")?.[0]?.({}, current.ctx);
  await mock.commands.get("accounts")?.handler("", current.ctx);
  await mock.commands.get("accounts")?.handler("", current.ctx);
  assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
  assert.equal(runtime.keys.get("anthropic"), "access-alpha");
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
});

test("provider accounts activate independently and default clears only one provider", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "personal", accounts: { personal: credential("codex") } },
      anthropic: { active: "work", accounts: { work: credential("claude") } },
    },
  });
  const mock = createMockPi();
  const providers = [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")];
  accountsExtension(mock.pi, { store, providers });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx, notifications } = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  );

  await startSessionAndWaitForCurrentProvider(mock, ctx);
  await waitForTest(() => keys.get("openai-codex") === "access-codex");
  assert.equal(keys.get("anthropic"), "access-claude");

  await mock.commands.get("accounts")?.handler("ignored", ctx);
  const data = await store.readAsync();
  assert.equal(data.providers.anthropic?.active, "work");
  assert.equal(data.providers["openai-codex"]?.active, "personal");
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "personal");
  assert.equal(keys.has("anthropic"), false);
  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.match(notifications.at(-1)?.message ?? "", /default Pi Anthropic login/);
});

test("concurrent sessions keep independent provider account selections", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: {
          alpha: credential("alpha"),
          beta: { ...credential("beta"), expires: 1 },
        },
      },
    },
  });
  const providers = [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")];
  const first = createMockPi();
  const second = createMockPi();
  accountsExtension(first.pi, { store, providers });
  accountsExtension(second.pi, { store, providers });
  const firstRuntime = runtimeHarness(first);
  const secondRuntime = runtimeHarness(second);
  const firstSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const secondSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const firstContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: firstRuntime.registry,
    sessionManager: firstSession,
  }).ctx;
  const secondContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: secondRuntime.registry,
    sessionManager: secondSession,
  }).ctx;

  await startSessionAndWaitForCurrentProvider(first, firstContext);
  await startSessionAndWaitForCurrentProvider(second, secondContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(secondRuntime.keys.get("anthropic"), "access-alpha");

  const secondMenuContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: secondRuntime.registry,
      sessionManager: secondSession,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  ).ctx;
  await second.commands.get("accounts")?.handler("ignored", secondMenuContext);
  assert.equal(secondRuntime.keys.get("anthropic"), "access-beta-refreshed");
  const sharedState = await store.readProviderAsync("anthropic");
  assert.equal(sharedState.active, "alpha");
  assert.equal(sharedState.accounts.beta?.access, "access-beta-refreshed");

  await first.events.get("before_agent_start")?.[0]?.({}, firstContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");

  const secondDefaultContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: secondRuntime.registry,
      sessionManager: secondSession,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await second.commands.get("accounts")?.handler("ignored", secondDefaultContext);
  assert.equal(secondRuntime.keys.has("anthropic"), false);
  assert.equal((await store.readProviderAsync("anthropic")).active, "alpha");
  await first.events.get("before_agent_start")?.[0]?.({}, firstContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
});

test("one extension instance isolates concurrent headless session owners", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const firstRuntime = runtimeHarness(mock);
  const secondRuntime = runtimeHarness(mock);
  const firstSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const secondSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const firstContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: firstRuntime.registry,
    sessionManager: firstSession,
  }).ctx;
  const secondContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: secondRuntime.registry,
    sessionManager: secondSession,
  }).ctx;

  await startSessionAndWaitForCurrentProvider(mock, firstContext);
  await startSessionAndWaitForCurrentProvider(mock, secondContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(secondRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(latestSessionSelections(firstSession).anthropic, "alpha");
  assert.equal(latestSessionSelections(secondSession).anthropic, "alpha");

  const secondMenuContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: secondRuntime.registry,
      sessionManager: secondSession,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", secondMenuContext);
  await mock.events.get("before_agent_start")?.[0]?.({}, firstContext);

  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(secondRuntime.keys.get("anthropic"), "access-beta");
  assert.equal(latestSessionSelections(firstSession).anthropic, "alpha");
  assert.equal(latestSessionSelections(secondSession).anthropic, "beta");
  assert.equal(mock.entries.length, 0);
  assert.equal(collectCredentialOffers(mock, firstSession, "anthropic")[0]?.access, "access-alpha");
  assert.equal(collectCredentialOffers(mock, secondSession, "anthropic")[0]?.access, "access-beta");

  await mock.events.get("session_shutdown")?.[0]?.({}, secondContext);
  assert.equal(secondRuntime.keys.has("anthropic"), false);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(collectCredentialOffers(mock, firstSession, "anthropic")[0]?.access, "access-alpha");
});

test("one extension instance keeps provider overlays scoped to each headless session", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": {
        active: "work",
        accounts: { work: credential("work") },
      },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("kimi-coding")] });
  const namedRuntime = runtimeHarness(mock, { isolateProviders: true });
  const defaultRuntime = runtimeHarness(mock, { isolateProviders: true });
  const namedSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const defaultSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  namedSession.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: namedSession.getSessionId(),
    providers: { "kimi-coding": "work" },
  });
  defaultSession.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: defaultSession.getSessionId(),
    providers: { "kimi-coding": null },
  });
  const namedContext = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: namedRuntime.registry,
    sessionManager: namedSession,
  }).ctx;
  const defaultContext = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: defaultRuntime.registry,
    sessionManager: defaultSession,
  }).ctx;

  await mock.events.get("session_start")?.[0]?.({}, namedContext);
  await mock.events.get("session_start")?.[0]?.({}, defaultContext);
  await mock.events.get("before_agent_start")?.[0]?.({}, namedContext);

  assert.equal(namedRuntime.keys.get("kimi-coding"), "pi-accounts-header-auth");
  assert.equal(defaultRuntime.keys.has("kimi-coding"), false);
  assert.deepEqual(namedRuntime.providerConfigs.get("kimi-coding"), {
    headers: { Authorization: "Bearer access-work" },
  });
  assert.equal(defaultRuntime.providerConfigs.has("kimi-coding"), false);

  await mock.events.get("session_shutdown")?.[0]?.({}, defaultContext);
  assert.deepEqual(namedRuntime.providerConfigs.get("kimi-coding"), {
    headers: { Authorization: "Bearer access-work" },
  });
});

test("session-local account selection restores on resume and ignores tree position", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  const providers = [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")];
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const first = createMockPi();
  accountsExtension(first.pi, { store, providers });
  const firstRuntime = runtimeHarness(first);
  const firstContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: firstRuntime.registry,
    sessionManager,
  }).ctx;
  await first.events.get("session_start")?.[0]?.({}, firstContext);
  const switchContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: firstRuntime.registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  ).ctx;
  await first.commands.get("accounts")?.handler("ignored", switchContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-beta");

  sessionManager.resetLeaf();
  sessionManager.appendCustomEntry("unrelated-state", { branch: true });
  const resumed = createMockPi();
  accountsExtension(resumed.pi, { store, providers });
  const resumedRuntime = runtimeHarness(resumed);
  const resumedContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: resumedRuntime.registry,
    sessionManager,
  }).ctx;
  await startSessionAndWaitForCurrentProvider(resumed, resumedContext, { reason: "resume" });

  assert.equal(resumedRuntime.keys.get("anthropic"), "access-beta");
  assert.equal((await store.readProviderAsync("anthropic")).active, "alpha");
});

test("restored sessions seed newly supported providers from the compatibility default", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
      "openai-codex": { active: "codex", accounts: { codex: credential("codex") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: sessionManager.getSessionId(),
    providers: { anthropic: null },
  });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    sessionManager,
  });
  await startSessionAndWaitForCurrentProvider(mock, ctx);

  assert.equal(keys.has("anthropic"), false);
  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "codex");
  assert.equal(latestSessionSelections(sessionManager)["github-copilot"], null);
});

test("malformed session selection fails closed and /accounts can recover to default", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 2,
    sessionId: sessionManager.getSessionId(),
    providers: { anthropic: "work" },
  });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx, notifications } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await startSessionAndWaitForCurrentProvider(mock, ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.match(notifications[0]?.message ?? "", /invalid.*\/accounts/iu);

  const recoveryContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", recoveryContext);
  assert.equal(keys.has("anthropic"), false);
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
});

test("session selection append failure retains the previous account", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await startSessionAndWaitForCurrentProvider(mock, context.ctx);
  assert.equal(keys.get("anthropic"), "access-alpha");

  sessionManager.appendCustomEntry = () => {
    throw new Error("session disk unavailable");
  };
  const switchContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  );
  await mock.commands.get("accounts")?.handler("ignored", switchContext.ctx);
  assert.match(switchContext.notifications.at(-1)?.message ?? "", /could not save/iu);
  await mock.events.get("before_agent_start")?.[0]?.({}, context.ctx);
  assert.equal(keys.get("anthropic"), "access-alpha");
  assert.equal((await store.readProviderAsync("anthropic")).active, "alpha");
});

test("initial session selection append failure fails closed and remains recoverable", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
  sessionManager.appendCustomEntry = () => {
    throw new Error("session disk unavailable");
  };
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await startSessionAndWaitForCurrentProvider(mock, context.ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.match(context.notifications[0]?.message ?? "", /could not persist/iu);

  sessionManager.appendCustomEntry = appendCustomEntry;
  const recoveryContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", recoveryContext);
  assert.equal(keys.has("anthropic"), false);
});

test("removal persistence failure leaves the missing selection fail closed", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await startSessionAndWaitForCurrentProvider(mock, context.ctx);
  sessionManager.appendCustomEntry = () => {
    throw new Error("session disk unavailable");
  };
  const removeContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  );
  await mock.commands.get("accounts")?.handler("ignored", removeContext.ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work, undefined);
  assert.match(removeContext.notifications.at(-1)?.message ?? "", /fail closed/iu);
});

test("credential mutation failure leaves the session selection and runtime unchanged", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  store.updateProvider = async () => {
    throw new Error("credential disk unavailable: private-refresh\u001b[31m");
  };
  const removeContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  );
  await mock.commands.get("accounts")?.handler("ignored", removeContext.ctx);
  assert.equal(keys.get("anthropic"), "access-work");
  assert.equal(latestSessionSelections(sessionManager).anthropic, "work");
  assert.match(removeContext.notifications.at(-1)?.message ?? "", /Could not remove the account/);
  assert.doesNotMatch(JSON.stringify(removeContext.notifications), /private-refresh/);
});

test("a removed session-selected credential fails closed until explicit recovery", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await store.updateProvider("anthropic", (state) => ({
    ...state,
    accounts: {},
  }));
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.equal((await store.readProviderAsync("anthropic")).active, "work");

  const recoveryContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", recoveryContext);
  assert.equal(keys.has("anthropic"), false);
});

test("session replacement prevents a stale switch menu from mutating accounts", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { personal: credential("personal"), work: credential("work") },
      },
    },
  });
  const originalReadProvider = store.readProviderAsync.bind(store);
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let reads = 0;
  store.readProviderAsync = async (providerId) => {
    reads += 1;
    if (reads === 1) {
      markReadStarted();
      await readReleased;
    }
    return originalReadProvider(providerId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { keys, registry } = runtimeHarness(mock);
  const oldContext = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Switch Anthropic account", "personal"] },
  ).ctx;
  const newContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  }).ctx;

  const stale = mock.commands.get("accounts")?.handler("ignored", oldContext);
  await readStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  releaseRead();
  await stale;
  await mock.events.get("before_agent_start")?.[0]?.({}, newContext);
  assert.equal((await store.readProviderAsync("anthropic")).active, "work");
  assert.equal(keys.get("anthropic"), "access-work");
});

test("session replacement prevents a stale remove menu from deleting accounts", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const originalUpdate = store.updateProvider.bind(store);
  let markUpdateStarted!: () => void;
  const updateStarted = new Promise<void>((resolve) => {
    markUpdateStarted = resolve;
  });
  let releaseUpdate!: () => void;
  const updateReleased = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  store.updateProvider = async (providerId, mutator) => {
    markUpdateStarted();
    await updateReleased;
    return originalUpdate(providerId, mutator);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { keys, registry } = runtimeHarness(mock);
  const oldContext = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  ).ctx;
  const newContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  }).ctx;

  const stale = mock.commands.get("accounts")?.handler("ignored", oldContext);
  await updateStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  releaseUpdate();
  await stale;
  await mock.events.get("before_agent_start")?.[0]?.({}, newContext);
  const state = await store.readProviderAsync("anthropic");
  assert.equal(state.active, "work");
  assert.equal(state.accounts.work?.access, "access-work");
  assert.equal(keys.get("anthropic"), "access-work");
});

test("startup returns while locked account initialization continues and first use waits for it", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("anthropic") } },
    },
  });
  const originalRead = store.readAsync.bind(store);
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let firstRead = true;
  store.readAsync = async () => {
    if (firstRead) {
      firstRead = false;
      markReadStarted();
      await readReleased;
    }
    return originalRead();
  };
  const anthropic = fakeProvider("anthropic");
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), anthropic, fakeProvider("github-copilot")],
  });
  const { keys, registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });

  let startupSettled = false;
  const startup = Promise.resolve(mock.events.get("session_start")?.[0]?.({}, ctx)).then(() => {
    startupSettled = true;
  });
  await readStarted;
  await Promise.resolve();
  assert.equal(startupSettled, true);

  let firstUseSettled = false;
  const firstUse = Promise.resolve(mock.events.get("before_agent_start")?.[0]?.({}, ctx)).then(() => {
    firstUseSettled = true;
  });
  await Promise.resolve();
  assert.equal(firstUseSettled, false);

  let readiness: Promise<unknown> | undefined;
  mock.eventBus.emit(OAUTH_CREDENTIAL_READINESS_CHANNEL, {
    session: sessionManager,
    provider: "anthropic",
    waitUntil(pending: Promise<unknown>) {
      readiness = pending;
    },
  });
  assert.ok(readiness);
  assert.doesNotThrow(() => {
    mock.eventBus.emit(OAUTH_CREDENTIAL_READINESS_CHANNEL, {
      session: sessionManager,
      provider: "anthropic",
      waitUntil() {
        throw new Error("consumer rejected readiness");
      },
    });
  });
  let readinessSettled = false;
  const observedReadiness = readiness.then(() => {
    readinessSettled = true;
  });
  await Promise.resolve();
  assert.equal(readinessSettled, false);

  releaseRead();
  await Promise.all([startup, firstUse, observedReadiness]);
  assert.equal(keys.get("anthropic"), "access-anthropic");
});

test("first use reuses the pending background provider activation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("anthropic") } },
    },
  });
  let markConversionStarted!: () => void;
  const conversionStarted = new Promise<void>((resolve) => {
    markConversionStarted = resolve;
  });
  let releaseConversion!: () => void;
  const conversionReleased = new Promise<void>((resolve) => {
    releaseConversion = resolve;
  });
  let conversions = 0;
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.toAuth = async (current) => {
    conversions += 1;
    markConversionStarted();
    await conversionReleased;
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [anthropic] });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  });

  let startupSettled = false;
  const startup = Promise.resolve(mock.events.get("session_start")?.[0]?.({}, ctx)).then(() => {
    startupSettled = true;
  });
  await conversionStarted;
  assert.equal(startupSettled, true);

  let firstUseSettled = false;
  const firstUse = Promise.resolve(mock.events.get("before_agent_start")?.[0]?.({}, ctx)).then(() => {
    firstUseSettled = true;
  });
  await Promise.resolve();
  assert.equal(firstUseSettled, false);
  assert.equal(conversions, 1);

  releaseConversion();
  await Promise.all([startup, firstUse]);
  assert.equal(conversions, 1);
  assert.equal(keys.get("anthropic"), "access-anthropic");
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("settled provider startup does not override later recovery while another provider is pending", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("old") } },
      openrouter: { active: "work", accounts: { work: credential("later") } },
    },
  });
  let anthropicConversions = 0;
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.toAuth = async (current) => {
    anthropicConversions += 1;
    if (anthropicConversions === 1) throw new Error("startup conversion failed");
    return { apiKey: current.access };
  };
  let markLaterStarted!: () => void;
  const laterStarted = new Promise<void>((resolve) => {
    markLaterStarted = resolve;
  });
  let releaseLater!: () => void;
  const laterReleased = new Promise<void>((resolve) => {
    releaseLater = resolve;
  });
  let laterCompleted = false;
  const later = fakeProvider("openrouter");
  later.oauth.toAuth = async (current) => {
    markLaterStarted();
    await laterReleased;
    laterCompleted = true;
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [anthropic, later] });
  const { keys, registry } = runtimeHarness(mock);
  let aborts = 0;
  const { ctx } = createMockContext({
    abort: () => {
      aborts += 1;
    },
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await laterStarted;
  assert.equal(anthropicConversions, 1);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);

  await mock.events.get("model_select")?.[0]?.({ model: { provider: "anthropic", id: "claude" } }, ctx);
  assert.equal(anthropicConversions, 2);
  assert.equal(keys.get("anthropic"), "access-old");
  await store.updateProvider("anthropic", (state) => ({
    ...state,
    accounts: { work: credential("new") },
  }));

  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  await mock.events.get("turn_start")?.[0]?.({}, ctx);
  assert.equal(anthropicConversions, 3);
  assert.equal(keys.get("anthropic"), "access-new");
  assert.equal(aborts, 0);

  releaseLater();
  await waitForTest(() => laterCompleted);
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("shutdown aborts blocked startup initialization and a later session starts cleanly", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("anthropic") } },
    },
  });
  const originalRead = store.readAsync.bind(store);
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let startupSignal: AbortSignal | undefined;
  store.readAsync = async (signal): Promise<never> => {
    startupSignal = signal;
    markReadStarted();
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
  const runtime = runtimeHarness(mock);
  const oldContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: runtime.registry,
    sessionManager: createTestSessionManager(),
  });

  await mock.events.get("session_start")?.[0]?.({}, oldContext.ctx);
  await readStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext.ctx);
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext.ctx);
  assert.equal(startupSignal?.aborted, true);
  assert.equal(runtime.keys.has("anthropic"), false);
  assert.equal(oldContext.statuses.get(ACCOUNTS_STATUS_KEY), undefined);

  store.readAsync = originalRead;
  const newContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: runtime.registry,
    sessionManager: createTestSessionManager(),
  });
  await mock.events.get("session_start")?.[0]?.({}, newContext.ctx);
  await mock.events.get("before_agent_start")?.[0]?.({}, newContext.ctx);
  assert.equal(runtime.keys.get("anthropic"), "access-anthropic");
  assert.equal(newContext.statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
  await mock.events.get("session_shutdown")?.[0]?.({}, newContext.ctx);
});

test("stale multi-provider startup stops before syncing later providers", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
      anthropic: { active: "work", accounts: { work: credential("anthropic") } },
    },
  });
  let releaseOld!: () => void;
  const oldBlocked = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let markOldStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    markOldStarted = resolve;
  });
  let codexConversions = 0;
  let anthropicConversions = 0;
  const codex = fakeProvider("openai-codex");
  codex.oauth.toAuth = async (current) => {
    codexConversions += 1;
    if (codexConversions === 1) {
      markOldStarted();
      await oldBlocked;
    }
    return { apiKey: current.access };
  };
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.toAuth = async (current) => {
    anthropicConversions += 1;
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, anthropic, fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const oldContext = createMockContext({
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;
  const newContext = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;

  const stale = mock.events.get("session_start")?.[0]?.({}, oldContext);
  await oldStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  releaseOld();
  await stale;
  await mock.events.get("before_agent_start")?.[0]?.({}, newContext);
  await waitForTest(() => anthropicConversions === 1);

  assert.equal(codexConversions, 2);
  assert.equal(anthropicConversions, 1);
});

test("default Codex auth does not invalidate connections on first observation", async () => {
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store: new AccountStore(new InMemoryAccountStorageBackend()),
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.deepEqual(invalidations, []);
});

test("Codex connections invalidate only when the applied account identity changes", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager("test-session");
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    sessionManager,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  assert.deepEqual(invalidations, ["test-session"]);
  const switchContext = createInteractiveAccountContext(
    {
      model: { provider: "openai-codex", id: "codex" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch OpenAI Codex account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", switchContext);
  assert.deepEqual(invalidations, ["test-session", "test-session"]);
});

test("connection invalidation tracks the credential actually applied before a shared replacement", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("old") } },
    },
  });
  const originalRead = store.readProviderAsync.bind(store);
  let reads = 0;
  store.readProviderAsync = async (providerId) => {
    const snapshot = await originalRead(providerId);
    if (providerId === "openai-codex") {
      reads += 1;
      if (reads === 3) {
        await store.updateProvider("openai-codex", (state) => ({
          ...state,
          accounts: { work: credential("new") },
        }));
      }
    }
    return snapshot;
  };
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager("credential-race-session");
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    sessionManager,
  });

  await startSessionAndWaitForCurrentProvider(mock, ctx);
  assert.equal(keys.get("openai-codex"), "access-old");
  assert.equal((await originalRead("openai-codex")).accounts.work?.access, "access-new");
  assert.deepEqual(invalidations, ["credential-race-session"]);

  await mock.events.get("model_select")?.[0]?.({ model: { provider: "openai-codex", id: "codex" } }, ctx);
  assert.equal(keys.get("openai-codex"), "access-new");
  assert.deepEqual(invalidations, ["credential-race-session", "credential-race-session"]);
});

test("an older overlapping provider sync cannot publish stale inactive state", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let signalFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirst = resolve;
  });
  let conversions = 0;
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.oauth.toAuth = async (current) => {
    conversions += 1;
    if (conversions === 1) {
      signalFirst?.();
      await firstBlocked;
      throw new Error("obsolete conversion failed");
    }
    return { apiKey: current.access };
  };
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, statuses } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  const older = mock.events.get("session_start")?.[0]?.({}, ctx);
  await firstStarted;
  await mock.events.get("model_select")?.[0]?.({ model: { provider: "openai-codex", id: "codex" } }, ctx);
  releaseFirst?.();
  await older;

  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.equal(statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
  assert.deepEqual(invalidations, ["test-session"]);
});

test("an obsolete invalidation failure cannot fail closed a newer successful sync", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const originalRead = store.readProviderAsync.bind(store);
  let reads = 0;
  let releaseObsoleteRead: (() => void) | undefined;
  const obsoleteReadBlocked = new Promise<void>((resolve) => {
    releaseObsoleteRead = resolve;
  });
  let signalObsoleteRead: (() => void) | undefined;
  const obsoleteReadStarted = new Promise<void>((resolve) => {
    signalObsoleteRead = resolve;
  });
  store.readProviderAsync = async (providerId) => {
    reads += 1;
    if (reads === 5) {
      signalObsoleteRead?.();
      await obsoleteReadBlocked;
    }
    return originalRead(providerId);
  };
  let invalidations = 0;
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = () => {
    invalidations += 1;
    if (invalidations === 1) throw new Error("obsolete cleanup failed");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, statuses } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  const older = mock.events.get("session_start")?.[0]?.({}, ctx);
  await obsoleteReadStarted;
  await mock.events.get("model_select")?.[0]?.({ model: { provider: "openai-codex", id: "codex" } }, ctx);
  releaseObsoleteRead?.();
  await older;

  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.equal(statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
});

test("connection invalidation failure replaces active Codex auth with fail-closed state", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = () => {
    throw new Error("socket cleanup failed");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, statuses } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  await startSessionAndWaitForCurrentProvider(mock, ctx);
  assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
  assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
});

test("a newer Radius account operation aborts stale catalog refresh work", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius-old") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  let firstSignal: AbortSignal | undefined;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let refreshes = 0;
  registry.refresh = async (options) => {
    refreshes += 1;
    if (refreshes === 1) {
      firstSignal = options.signal;
      markFirstStarted();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));

  const stale = ensureStoredSelection(coordinator, ctx, store);
  await firstStarted;
  await store.updateProvider("radius", (state) => ({
    ...state,
    accounts: { work: credential("radius-new") },
  }));
  const current = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(current, {
    status: "active",
    providerId: "radius",
    accountName: "work",
  });
  assert.deepEqual(await stale, { status: "inactive", providerId: "radius" });
  assert.equal(firstSignal?.aborted, true);
  assert.equal(keys.get("radius"), "access-radius-new");
});

test("stale Radius default restoration cannot fail close a newer named activation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      radius: {
        active: "alpha",
        accounts: { alpha: credential("radius-alpha"), beta: credential("radius-beta") },
      },
    },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  let markDefaultStarted!: () => void;
  const defaultStarted = new Promise<void>((resolve) => {
    markDefaultStarted = resolve;
  });
  let refreshes = 0;
  registry.refresh = async (options) => {
    refreshes += 1;
    if (refreshes === 2) {
      markDefaultStarted();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));
  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");

  await store.updateProvider("radius", (state) => ({ ...state, active: undefined }));
  const staleDefault = ensureStoredSelection(coordinator, ctx, store);
  await defaultStarted;
  await store.updateProvider("radius", (state) => ({ ...state, active: "beta" }));
  const current = await ensureStoredSelection(coordinator, ctx, store);

  assert.equal(current.status, "active");
  assert.deepEqual(await staleDefault, { status: "inactive", providerId: "radius" });
  assert.equal(keys.get("radius"), "access-radius-beta");
  assert.equal(refreshes, 3);
});

test("new provider adapters refresh expiring named credentials before activation", async () => {
  for (const providerId of ["xai", "kimi-coding", "openrouter", "radius"] as const) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        [providerId]: {
          active: "work",
          accounts: { work: { ...credential(providerId), expires: 0 } },
        },
      },
    });
    const mock = createMockPi();
    const { keys, registry } = runtimeHarness(mock);
    const { ctx } = createMockContext({ modelRegistry: registry });
    const coordinator = new RuntimeAuthCoordinator(fakeProvider(providerId));

    assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
    assert.equal((await store.readProviderAsync(providerId)).accounts.work?.access, `access-${providerId}-refreshed`);
    assert.equal(
      keys.get(providerId),
      providerId === "kimi-coding" ? "pi-accounts-header-auth" : `access-${providerId}-refreshed`,
    );
  }
});

test("background startup reports activation failures without exposing credentials", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("secret") } },
    },
  });
  const failing = fakeProvider("anthropic");
  failing.oauth.toAuth = async (current) => {
    throw new Error(`bad ${current.access} and ${current.refresh}`);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [failing] });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx, notifications } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await waitForTest(() => notifications.some((notification) => notification.message.includes("failed closed")));
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  const message = notifications.map((notification) => notification.message).join("\n");
  assert.doesNotMatch(message, /access-secret|refresh-secret/);
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("refresh and auth derivation failures fail closed, redact secrets, and abort only the affected provider", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("secret") } },
    },
  });
  const failing = fakeProvider("anthropic");
  failing.oauth.toAuth = async (current) => {
    throw new Error(`bad ${current.access} and ${current.refresh}`);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), failing, fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  let aborts = 0;
  const { ctx, statuses } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    abort: () => {
      aborts += 1;
    },
  });

  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
  assert.doesNotMatch(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /access-secret|refresh-secret/);
  await mock.events.get("turn_start")?.[0]?.({}, ctx);
  assert.equal(aborts, 1);

  const other = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    abort: () => {
      aborts += 1;
    },
  }).ctx;
  await mock.events.get("turn_start")?.[0]?.({}, other);
  assert.equal(aborts, 1);
});

test("account reset during OAuth conversion cannot restore a stale runtime override", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("claude") } },
    },
  });
  let releaseConversion: (() => void) | undefined;
  const conversionBlocked = new Promise<void>((resolve) => {
    releaseConversion = resolve;
  });
  let signalConversion: (() => void) | undefined;
  const conversionStarted = new Promise<void>((resolve) => {
    signalConversion = resolve;
  });
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.toAuth = async (current) => {
    signalConversion?.();
    await conversionBlocked;
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), anthropic, fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });

  const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
  await conversionStarted;
  const resetContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  const reset = mock.commands.get("accounts")?.handler("ignored", resetContext);
  releaseConversion?.();
  await Promise.all([startup, reset]);
  assert.equal((await store.readProviderAsync("anthropic")).active, "work");
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
  assert.equal(keys.has("anthropic"), false);
});

test("an overlapping account switch reports when its requested account was superseded", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": {
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  let releaseAlpha: (() => void) | undefined;
  const alphaBlocked = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  let signalAlpha: (() => void) | undefined;
  const alphaStarted = new Promise<void>((resolve) => {
    signalAlpha = resolve;
  });
  const codex = fakeProvider("openai-codex");
  codex.oauth.toAuth = async (current) => {
    if (current.access === "access-alpha") {
      signalAlpha?.();
      await alphaBlocked;
    }
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const olderContext = createInteractiveAccountContext(
    {
      model: { provider: "openai-codex", id: "codex" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch OpenAI Codex account", "alpha"] },
  );
  const newerContext = createInteractiveAccountContext(
    {
      model: { provider: "openai-codex", id: "codex" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch OpenAI Codex account", "beta"] },
  );

  const older = mock.commands.get("accounts")?.handler("ignored", olderContext.ctx);
  await alphaStarted;
  await mock.commands.get("accounts")?.handler("ignored", newerContext.ctx);
  releaseAlpha?.();
  await older;

  assert.equal((await store.readProviderAsync("openai-codex")).active, undefined);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "beta");
  assert.match(olderContext.notifications.at(-1)?.message ?? "", /alpha.*superseded/);
});
