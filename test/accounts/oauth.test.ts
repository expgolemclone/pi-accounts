import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import accountsExtension, { AccountStore, FAIL_CLOSED_API_KEY, parseAccountName } from "../../src/accounts.js";
import {
  createBuiltinProviderAdapters,
  createOAuthInteraction,
  loginWithOAuthUI,
  resolveProviderOAuth,
} from "../../src/oauth.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../../src/oauth-credential-source.js";
import { RuntimeAuthCoordinator } from "../../src/runtime-auth.js";
import { InMemoryAccountStorageBackend } from "../../src/storage.js";
import { isolateAccountEnvironment } from "../isolate-account-environment.js";
import { createCustomSelectorHarness, createMockPi } from "../support.js";

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

test("built-in provider adapters preserve each provider's complete OAuth auth shape", async () => {
  const adapters = createBuiltinProviderAdapters();
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const base = credential("contract");

  for (const id of ["openai", "meta"] as const) {
    assert.deepEqual(await byId.get(id)?.oauth.toAuth(base), { apiKey: "access-contract" });
    assert.equal(byId.get(id)?.requiresApiKeyBridge, false);
    assert.equal(byId.get(id)?.supportsApiKey, true);
  }
  const providersModuleId = "@earendil-works/pi-ai/providers/all";
  const { builtinProviders } = await import(providersModuleId);
  assert.deepEqual(
    [...byId.keys()].sort(),
    builtinProviders()
      .filter((provider: { auth: { oauth?: unknown } }) => provider.auth.oauth)
      .map((provider: { id: string }) => provider.id)
      .sort(),
  );
  for (const provider of builtinProviders()) {
    const adapter = byId.get(provider.id);
    if (adapter) assert.equal(adapter.supportsApiKey, !!provider.auth.apiKey);
  }
  assert.equal(typeof byId.get("openai-codex")?.invalidateConnections, "function");
  assert.deepEqual(await byId.get("openai-codex")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.deepEqual(await byId.get("anthropic")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  const copilotCredential = credential("contract", {
    access: "tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=1",
    enterpriseUrl: "github.example.com",
    availableModelIds: ["allowed"],
  });
  assert.deepEqual(await byId.get("github-copilot")?.oauth.toAuth(copilotCredential), {
    apiKey: copilotCredential.access,
    baseUrl: "https://api.business.githubcopilot.com",
  });
  assert.deepEqual(await byId.get("xai")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.deepEqual(await byId.get("kimi-coding")?.oauth.toAuth(base), {
    headers: { Authorization: "Bearer access-contract" },
  });
  assert.deepEqual(await byId.get("openrouter")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.deepEqual(await byId.get("radius")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.equal(byId.get("radius")?.refreshModelCatalogAfterAuth, true);
  assert.deepEqual([...byId.keys()].sort(), [
    "anthropic",
    "github-copilot",
    "kimi-coding",
    "meta",
    "openai",
    "openai-codex",
    "openrouter",
    "radius",
    "xai",
  ]);
  const radius = byId.get("radius");
  assert.ok(radius);
  const activeRadiusOAuth = fakeProvider("radius").oauth;
  assert.equal(
    resolveProviderOAuth(radius, {
      modelRegistry: {
        getProvider: () => ({ auth: { oauth: activeRadiusOAuth } }),
      } as never,
    }),
    activeRadiusOAuth,
  );
});

test("OAuth interaction preserves provider prompts, cancellation, and notifications", async () => {
  const dialogSignals: Array<AbortSignal | undefined> = [];
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    input: async (_title: string, _placeholder: string, options?: { signal?: AbortSignal }) => {
      dialogSignals.push(options?.signal);
      return undefined;
    },
    select: async (_title: string, _options: string[], options?: { signal?: AbortSignal }) => {
      dialogSignals.push(options?.signal);
      return "Device login";
    },
  });
  const owner = new AbortController();
  const interaction = createOAuthInteraction(ctx, "Example", owner.signal);
  assert.equal(interaction.signal, owner.signal);
  assert.equal(
    await interaction.prompt({
      type: "select",
      message: "Method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device", label: "Device login" },
      ],
    }),
    "device",
  );
  await assert.rejects(interaction.prompt({ type: "manual_code", message: "Code" }), /Login cancelled/);
  assert.deepEqual(dialogSignals, [owner.signal, owner.signal]);
  interaction.notify({
    type: "device_code",
    userCode: "ABCD",
    verificationUri: "https://example.test/device",
  });
  assert.match(notifications.at(-1)?.message ?? "", /ABCD/);
});

test("TUI OAuth login uses Pi's native dialog across provider-owned steps", async () => {
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  let continueToPrompt!: () => void;
  const authShown = new Promise<void>((resolve) => {
    continueToPrompt = resolve;
  });
  let selectedMethod: string | undefined;
  let manualCode: string | undefined;
  const provider = fakeProvider("github-copilot");
  provider.oauth.login = async (interaction) => {
    interaction.notify({
      type: "info",
      message: "Sign in with GitHub",
      links: [{ label: "Help", url: "https://example.test/help" }],
    });
    await authShown;
    selectedMethod = await interaction.prompt({
      type: "select",
      message: "Choose login method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device", label: "Device login" },
      ],
    });
    interaction.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.test/device",
    });
    interaction.notify({ type: "progress", message: "Checking authorization..." });
    manualCode = await interaction.prompt({ type: "manual_code", message: "Paste callback:" });
    return credential("native-dialog", { availableModelIds: ["allowed"] });
  };
  const { ctx } = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory, 100);
      return harness.resultPromise;
    },
  });

  const login = loginWithOAuthUI(ctx, provider, new AbortController().signal);
  await waitForTest(() => harness !== undefined);
  assert.ok(harness);
  assert.equal(harness.isFocusable, true);
  assert.match(harness.render().join("\n"), /Login to GitHub Copilot/);
  assert.match(harness.render().join("\n"), /Sign in with GitHub/);
  assert.match(harness.render().join("\n"), /Help: https:\/\/example\.test\/help/);

  continueToPrompt();
  await waitForTest(() => harness?.render().join("\n").includes("Device login") ?? false);
  assert.match(harness.render().join("\n"), /Choose login method/);
  harness.handleInput("tui.select.down");
  harness.handleInput("tui.select.confirm");
  await waitForTest(() => harness?.render().join("\n").includes("ABCD-EFGH") ?? false);
  const loginScreen = harness.render().join("\n");
  assert.match(loginScreen, /https:\/\/example\.test\/device/);
  assert.match(loginScreen, /Enter code: ABCD-EFGH/);
  assert.match(loginScreen, /Waiting for authentication/);
  assert.match(loginScreen, /Checking authorization/);
  assert.match(loginScreen, /Paste callback/);

  harness.setFocused(true);
  harness.handleInput("callback-value");
  harness.handleInput("tui.input.submit");
  assert.equal((await login).access, "access-native-dialog");
  assert.equal(selectedMethod, "device");
  assert.equal(manualCode, "callback-value");
});

test("TUI OAuth login aborts provider work on Escape and component disposal", async () => {
  for (const cancellation of ["escape", "dispose"] as const) {
    let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
    let providerSignal: AbortSignal | undefined;
    const provider = fakeProvider("anthropic");
    provider.oauth.login = async (interaction) => {
      providerSignal = interaction.signal;
      await new Promise<void>((resolve) => {
        if (interaction.signal.aborted) resolve();
        else interaction.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("Login cancelled");
    };
    const { ctx } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        harness = createCustomSelectorHarness(factory, 100);
        return harness.resultPromise;
      },
    });

    const login = loginWithOAuthUI(ctx, provider, new AbortController().signal);
    await waitForTest(() => harness !== undefined && providerSignal !== undefined);
    assert.ok(harness);
    if (cancellation === "escape") harness.handleInput("tui.select.cancel");
    else harness.dispose();
    await assert.rejects(login, /Login cancelled/);
    assert.equal(providerSignal?.aborted, true);
  }
});

test("TUI OAuth login closes when its menu owner is cancelled", async () => {
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  let providerSignal: AbortSignal | undefined;
  const provider = fakeProvider("openai-codex");
  provider.oauth.login = async (interaction) => {
    providerSignal = interaction.signal;
    await new Promise<void>((resolve) => {
      if (interaction.signal.aborted) resolve();
      else interaction.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("Login cancelled");
  };
  const owner = new AbortController();
  const { ctx } = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory, 100);
      return harness.resultPromise;
    },
  });

  const login = loginWithOAuthUI(ctx, provider, owner.signal);
  await waitForTest(() => harness !== undefined && providerSignal !== undefined);
  owner.abort();
  await assert.rejects(login, /Login cancelled/);
  assert.equal(providerSignal?.aborted, true);
});

test("account names reserve default for Pi login", () => {
  assert.equal(parseAccountName(" work-1 ").ok, true);
  assert.equal(parseAccountName("../secret").ok, false);
  assert.equal(parseAccountName("default").ok, true);
});

test("accounts empty state offers login and defaults and ignores command arguments", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: [] },
  );

  await mock.commands.get("accounts")?.handler("anything ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /No saved accounts yet/);
  assert.deepEqual(selectCalls[0]?.options, ["Login new account", "Set default account"]);
});

test("accounts menu prioritizes login when the current provider has no saved accounts", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { "openai-codex": { accounts: { codex: credential("codex") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.deepEqual(selectCalls[0]?.options, [
    "Login new account",
    "Switch another provider’s account",
    "Remove account",
    "Set default account",
  ]);
});

test("generic login stores the full provider-owned credential and activates it", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Login new account", "GitHub Copilot"], inputs: ["personal"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);
  const stored = (await store.readAsync()).providers["github-copilot"];
  assert.equal(stored?.active, undefined);
  assert.equal(latestSessionSelections(sessionManager)["github-copilot"], "personal");
  assert.deepEqual(stored?.accounts.personal?.availableModelIds, ["allowed"]);
  assert.equal(keys.get("github-copilot"), "access-login-github-copilot");
});

test("xAI, Kimi, OpenRouter, and Radius login routes activate named OAuth accounts", async () => {
  for (const providerId of ["xai", "kimi-coding", "openrouter", "radius"] as const) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    const provider = fakeProvider(providerId);
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [provider] });
    const { registry, keys, refreshCalls } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    const modelIds = {
      "kimi-coding": "k3",
      openrouter: "openrouter-model",
      radius: "radius-model",
      xai: "grok-4.3",
    };
    const { ctx } = createInteractiveAccountContext(
      {
        model: { provider: providerId, id: modelIds[providerId] },
        modelRegistry: registry,
        sessionManager,
      },
      { selections: ["Login new account", provider.displayName], inputs: ["work"] },
    );

    await mock.commands.get("accounts")?.handler("ignored", ctx);
    const state = await store.readProviderAsync(providerId);
    assert.equal(state.active, undefined);
    assert.equal(latestSessionSelections(sessionManager)[providerId], "work");
    assert.equal(state.accounts.work?.access, `access-login-${providerId}`);
    assert.equal(
      keys.get(providerId),
      providerId === "kimi-coding" ? "pi-accounts-header-auth" : `access-login-${providerId}`,
    );
    assert.equal(refreshCalls.length, providerId === "radius" ? 1 : 0);
  }
});

test("session shutdown aborts idle OAuth login before stale credentials can publish", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  let loginSignal: AbortSignal | undefined;
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.login = async (interaction) => {
    loginSignal = interaction.signal;
    loginStarted();
    if (!loginSignal) throw new Error("Missing OAuth login signal");
    await new Promise<void>((resolve) => {
      if (loginSignal?.aborted) resolve();
      else loginSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return credential("stale");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx } = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
    },
    { selections: ["Login new account", "GitHub Copilot"], inputs: ["personal"] },
  );

  const login = mock.commands.get("accounts")?.handler("ignored", ctx);
  await started;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await login;

  assert.ok(loginSignal);
  assert.equal(loginSignal.aborted, true);
  const state = await store.readProviderAsync("github-copilot");
  assert.equal(state.active, undefined);
  assert.deepEqual(Object.keys(state.accounts), []);
});

test("login rejects default as a reserved account name", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, notifications } = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Login new account", "Anthropic"], inputs: ["default"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.equal((await store.readProviderAsync("anthropic")).accounts.default, undefined);
  assert.match(notifications.at(-1)?.message ?? "", /reserved/);
});

test("login asks before replacing an existing account name", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { anthropic: { active: "work", accounts: { work: credential("old") } } },
  });
  let logins = 0;
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.login = async () => {
    logins += 1;
    return credential("new");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), anthropic, fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const cancelled = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Login new account", "Anthropic"], inputs: ["work"], confirms: [false] },
  );

  await mock.commands.get("accounts")?.handler("ignored", cancelled.ctx);
  assert.equal(logins, 0);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-old");
  assert.match(cancelled.confirmCalls[0]?.message ?? "", /already exists/);

  const replaced = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Login new account", "Anthropic"], inputs: ["work"], confirms: [true] },
  );
  await mock.commands.get("accounts")?.handler("ignored", replaced.ctx);
  assert.equal(logins, 1);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-new");
});

test("login leaves concurrent session models unchanged without a session-scoped model action", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const codex = fakeProvider("openai-codex");
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { keys, registry } = runtimeHarness(mock);
  const firstModel = { provider: "anthropic", id: "claude" };
  const unknownModel = { provider: "unknown", id: "unknown", api: "unknown" };
  const firstContext = createMockContext({
    model: firstModel,
    modelRegistry: registry,
    sessionManager: createTestSessionManager("first-onboarding-session"),
  }).ctx;
  await mock.events.get("session_start")?.[0]?.({}, firstContext);
  const { ctx } = createInteractiveAccountContext(
    {
      model: unknownModel,
      modelRegistry: registry,
      sessionManager: createTestSessionManager("second-onboarding-session"),
    },
    { selections: ["Login new account", "OpenAI Codex"], inputs: ["work"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.equal(keys.get("openai-codex"), "access-login-openai-codex");
  assert.equal(mock.setModels.length, 0);
  assert.deepEqual(firstModel, { provider: "anthropic", id: "claude" });
  assert.deepEqual(unknownModel, { provider: "unknown", id: "unknown", api: "unknown" });
});

test("credential source offers a refreshed active credential as defensive session-bound clones", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "work",
        accounts: {
          work: {
            ...credential("expired", { availableModelIds: ["allowed"] }),
            expires: 1,
          },
        },
      },
    },
  });
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.refresh = async (current) => ({
    ...current,
    access: "access-refreshed",
    expires: Date.now() + 60 * 60 * 1000,
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "github-copilot", id: "allowed" },
    modelRegistry: registry,
    sessionManager,
  });

  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
  await startSessionAndWaitForCurrentProvider(mock, ctx);

  const first = collectCredentialOffers(mock, sessionManager, "github-copilot");
  assert.equal(first.length, 1);
  const firstOffer = first[0];
  assert.ok(firstOffer);
  assert.equal(firstOffer.access, "access-refreshed");
  firstOffer.access = "caller-mutated";
  (firstOffer.availableModelIds as string[]).push("caller-mutated");
  const second = collectCredentialOffers(mock, sessionManager, "github-copilot");
  assert.equal(second[0]?.access, "access-refreshed");
  assert.deepEqual(second[0]?.availableModelIds, ["allowed"]);
  assert.deepEqual(collectCredentialOffers(mock, {}, "github-copilot"), []);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "anthropic"), []);

  assert.doesNotThrow(() => {
    mock.eventBus.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, {
      session: sessionManager,
      provider: "github-copilot",
      offer() {
        throw new Error("consumer rejected offer");
      },
    });
  });
  const malformed = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(malformed, "session", {
    get() {
      throw new Error("malformed request");
    },
  });
  assert.doesNotThrow(() => mock.eventBus.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, malformed));

  const defaultContext = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch GitHub Copilot account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", defaultContext);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
});

test("credential source suppresses pending, stale, failed-closed, and replaced activations", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "first",
        accounts: {
          first: credential("first", { availableModelIds: ["allowed"] }),
          second: credential("second", { availableModelIds: ["allowed"] }),
        },
      },
    },
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let notifyFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.toAuth = async (current) => {
    if (current.access === "access-first") {
      notifyFirst();
      await firstBlocked;
    }
    if (current.access === "access-failing") throw new Error("conversion failed");
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "github-copilot", id: "allowed" },
    modelRegistry: registry,
    sessionManager,
  });

  const older = mock.events.get("session_start")?.[0]?.({}, ctx);
  await firstStarted;
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
  const secondContext = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch GitHub Copilot account", "second"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", secondContext);
  assert.equal(collectCredentialOffers(mock, sessionManager, "github-copilot")[0]?.access, "access-second");
  releaseFirst();
  await older;
  assert.equal(collectCredentialOffers(mock, sessionManager, "github-copilot")[0]?.access, "access-second");

  await store.updateProvider("github-copilot", (state) => ({
    ...state,
    accounts: { ...state.accounts, failing: credential("failing") },
  }));
  const failingContext = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch GitHub Copilot account", "failing"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", failingContext);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);

  const replacement = createMockContext({
    model: { provider: "github-copilot", id: "allowed" },
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await mock.events.get("session_start")?.[0]?.({}, replacement);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
});

test("session replacement invalidates a pending credential offer before old work resumes", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "work",
        accounts: { work: credential("work") },
      },
    },
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let notifyFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  let conversions = 0;
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.toAuth = async (current) => {
    conversions += 1;
    if (conversions === 1) {
      notifyFirst();
      await firstBlocked;
    }
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const oldSession = createTestSessionManager();
  const newSession = createTestSessionManager();
  const oldContext = createMockContext({ modelRegistry: registry, sessionManager: oldSession }).ctx;
  const newContext = createMockContext({ modelRegistry: registry, sessionManager: newSession }).ctx;

  const oldStart = mock.events.get("session_start")?.[0]?.({}, oldContext);
  await firstStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  await waitForTest(() => collectCredentialOffers(mock, newSession, "github-copilot").length === 1);
  assert.deepEqual(collectCredentialOffers(mock, oldSession, "github-copilot"), []);
  assert.equal(collectCredentialOffers(mock, newSession, "github-copilot")[0]?.access, "access-work");
  releaseFirst();
  await oldStart;
  assert.deepEqual(collectCredentialOffers(mock, oldSession, "github-copilot"), []);
  assert.equal(collectCredentialOffers(mock, newSession, "github-copilot")[0]?.access, "access-work");
});

test("Radius menu cancellation aborts post-login catalog work and fails closed", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  registry.refresh = async (options) => {
    markRefreshStarted();
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));
  const owner = new AbortController();

  const activation = ensureStoredSelection(coordinator, ctx, store, Date.now(), owner.signal);
  await refreshStarted;
  owner.abort(new DOMException("Menu cancelled", "AbortError"));
  assert.equal((await activation).status, "error");
  assert.equal(keys.get("radius"), FAIL_CLOSED_API_KEY);
});
