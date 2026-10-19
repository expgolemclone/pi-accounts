import assert from "node:assert/strict";
import { InMemoryCredentialStore, type ModelAuth } from "@earendil-works/pi-ai";
import { initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import accountsExtension, {
  AccountStore,
  FAIL_CLOSED_API_KEY,
  type StoredOAuthCredential,
} from "../../src/accounts.js";
import { createBuiltinProviderAdapters } from "../../src/oauth.js";
import { RuntimeAuthCoordinator } from "../../src/runtime-auth.js";
import { InMemoryAccountStorageBackend } from "../../src/storage.js";
import { isolateAccountEnvironment } from "../isolate-account-environment.js";
import { createMockPi } from "../support.js";

import {
  collectCredentialOffers,
  createMockContext,
  createTestSessionManager,
  credential,
  ensureStoredSelection,
  fakeProvider,
  runtimeHarness,
  startSessionAndWaitForCurrentProvider,
  waitForTest,
} from "./fixtures.js";

isolateAccountEnvironment();
beforeAll(() => initTheme("dark", false));

test("xAI named OAuth applies its access token and restores default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { xai: { active: "work", accounts: { work: credential("xai") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "xai", id: "grok-4.3" },
    modelRegistry: registry,
    sessionManager,
  });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("xai"));

  const active = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(active, {
    status: "active",
    providerId: "xai",
    accountName: "work",
  });
  coordinator.publishCredentialOffer(ctx, active, "work:access-xai");
  assert.equal(keys.get("xai"), "access-xai");
  const offers: StoredOAuthCredential[] = [];
  coordinator.offerCredential({
    session: sessionManager,
    provider: "xai",
    offer: (candidate: StoredOAuthCredential) => offers.push(candidate),
  });
  assert.equal(offers[0]?.access, "access-xai");

  await store.updateProvider("xai", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "xai",
  });
  assert.equal(keys.has("xai"), false);
});

test("OpenRouter named OAuth applies its access token and restores default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      openrouter: {
        active: "work",
        accounts: { work: credential("openrouter", { refresh: "" }) },
      },
    },
  });
  const mock = createMockPi();
  const { keys, refreshCalls, registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "openrouter", id: "openrouter-model" },
    modelRegistry: registry,
    sessionManager,
  });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("openrouter"));

  const active = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(active, {
    status: "active",
    providerId: "openrouter",
    accountName: "work",
  });
  coordinator.publishCredentialOffer(ctx, active, "work:access-openrouter");
  const offers: StoredOAuthCredential[] = [];
  coordinator.offerCredential({
    session: sessionManager,
    provider: "openrouter",
    offer: (candidate: StoredOAuthCredential) => offers.push(candidate),
  });
  assert.equal(offers[0]?.refresh, "");
  assert.equal(keys.get("openrouter"), "access-openrouter");
  assert.deepEqual(refreshCalls, []);

  await store.updateProvider("openrouter", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "openrouter",
  });
  assert.equal(keys.has("openrouter"), false);
  assert.deepEqual(refreshCalls, []);
});

test("OpenRouter activation observes an already cancelled menu operation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      openrouter: { active: "work", accounts: { work: credential("openrouter") } },
    },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("openrouter"));
  const owner = new AbortController();
  owner.abort(new DOMException("Menu cancelled", "AbortError"));

  assert.equal((await ensureStoredSelection(coordinator, ctx, store, Date.now(), owner.signal)).status, "error");
  assert.equal(keys.get("openrouter"), FAIL_CLOSED_API_KEY);
});

test("Radius resolves OAuth from Pi's active gateway provider", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const radius = createBuiltinProviderAdapters().find((provider) => provider.id === "radius");
  assert.ok(radius);
  const activeOAuth = fakeProvider("radius").oauth;
  activeOAuth.toAuth = async (current) => ({ apiKey: `gateway:${current.access}` });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  const modelRegistry = {
    ...registry,
    getProvider: () => ({ auth: { oauth: activeOAuth } }),
  };
  const { ctx } = createMockContext({ modelRegistry });
  const coordinator = new RuntimeAuthCoordinator(radius);

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.equal(keys.get("radius"), "gateway:access-radius");
});

test("Radius refreshes its dynamic catalog for named and restored default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, models, registry } = runtimeHarness(mock);
  const refreshKeys: Array<string | undefined> = [];
  registry.refresh = async (options) => {
    refreshKeys.push(keys.get("radius"));
    assert.deepEqual(options.providers, ["radius"]);
    assert.equal(options.allowNetwork, true);
    assert.equal(options.signal?.aborted, false);
    models.splice(
      models.findIndex((model) => model.provider === "radius"),
      1,
      {
        provider: "radius",
        id: keys.has("radius") ? "named-radius-model" : "default-radius-model",
        baseUrl: "https://radius.pi.dev",
      },
    );
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));

  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "active",
    providerId: "radius",
    accountName: "work",
  });
  assert.equal(keys.get("radius"), "access-radius");
  assert.equal(
    models.some((model) => model.id === "named-radius-model"),
    true,
  );
  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.deepEqual(refreshKeys, ["access-radius"]);

  await store.updateProvider("radius", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "radius",
  });
  assert.equal(keys.has("radius"), false);
  assert.equal(
    models.some((model) => model.id === "default-radius-model"),
    true,
  );
  assert.deepEqual(refreshKeys, ["access-radius", undefined]);
});

test("Radius rebinds a retained selected model to its refreshed endpoint", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { models, registry } = runtimeHarness(mock);
  const selected = registry.find("radius", "radius-model");
  assert.ok(selected);
  registry.refresh = async () => {
    const radius = models.find((model) => model.provider === "radius");
    assert.ok(radius);
    radius.baseUrl = "https://account.radius.example";
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ model: selected, modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.equal(mock.setModels.length, 0);
  assert.equal(selected.baseUrl, "https://account.radius.example");
});

test("Radius model rebinding stays scoped to each concurrent session context", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const first = runtimeHarness(mock, { isolateProviders: true });
  const second = runtimeHarness(mock, { isolateProviders: true });
  const firstSelected = first.registry.find("radius", "radius-model");
  const secondSelected = second.registry.find("radius", "radius-model");
  assert.ok(firstSelected);
  assert.ok(secondSelected);
  first.registry.refresh = async () => {
    const radius = first.models.find((model) => model.provider === "radius");
    assert.ok(radius);
    radius.baseUrl = "https://first.radius.example";
    return { aborted: false, errors: new Map<string, Error>() };
  };
  second.registry.refresh = async () => {
    const radius = second.models.find((model) => model.provider === "radius");
    assert.ok(radius);
    radius.baseUrl = "https://second.radius.example";
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const firstContext = createMockContext({
    model: firstSelected,
    modelRegistry: first.registry,
    sessionManager: createTestSessionManager("first-radius-session"),
  }).ctx;
  const secondContext = createMockContext({
    model: secondSelected,
    modelRegistry: second.registry,
    sessionManager: createTestSessionManager("second-radius-session"),
  }).ctx;
  const firstCoordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));
  const secondCoordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));

  assert.equal((await ensureStoredSelection(firstCoordinator, firstContext, store)).status, "active");
  assert.equal((await ensureStoredSelection(secondCoordinator, secondContext, store)).status, "active");
  assert.equal(firstSelected.baseUrl, "https://first.radius.example");
  assert.equal(secondSelected.baseUrl, "https://second.radius.example");
  assert.equal(mock.setModels.length, 0);
});

test("Radius fails closed when the selected model disappears from the refreshed catalog", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, models, registry } = runtimeHarness(mock);
  const selected = registry.find("radius", "radius-model");
  assert.ok(selected);
  registry.refresh = async () => {
    models.splice(
      models.findIndex((model) => model.provider === "radius"),
      1,
    );
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ model: selected, modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.match(result.message, /model radius-model is unavailable/);
  assert.equal(keys.get("radius"), FAIL_CLOSED_API_KEY);
});

test("Radius catalog refresh errors fail closed", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  registry.refresh = async () => ({
    aborted: false,
    errors: new Map([["radius", new Error("catalog unavailable")]]),
  });
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.match(result.message, /catalog unavailable/);
  assert.equal(keys.get("radius"), FAIL_CLOSED_API_KEY);
});

test("Radius keeps the explicit session account when the global default changes", async () => {
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
  let refreshes = 0;
  registry.refresh = async () => {
    refreshes += 1;
    if (refreshes === 1) {
      await store.updateProvider("radius", (state) => ({ ...state, active: "beta" }));
    }
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("radius"));

  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "active",
    providerId: "radius",
    accountName: "alpha",
  });
  assert.equal(keys.get("radius"), "access-radius-alpha");
  assert.equal((await store.readProviderAsync("radius")).active, "beta");
  assert.equal(refreshes, 1);
});

test("Radius session replacement aborts the stale catalog refresh", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("radius")] });
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
  const oldContext = createMockContext({
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;
  const newContext = createMockContext({
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;

  const oldStart = mock.events.get("session_start")?.[0]?.({}, oldContext);
  await firstStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  await oldStart;
  await waitForTest(() => refreshes === 2);
  assert.equal(firstSignal?.aborted, true);
  assert.equal(refreshes, 2);
  assert.equal(keys.get("radius"), "access-radius");
});

test("Radius session shutdown aborts a pending catalog refresh and removes runtime auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("radius")] });
  const { keys, registry } = runtimeHarness(mock);
  let refreshSignal: AbortSignal | undefined;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  registry.refresh = async (options) => {
    refreshSignal = options.signal;
    markRefreshStarted();
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });

  const start = mock.events.get("session_start")?.[0]?.({}, ctx);
  await refreshStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await start;
  assert.equal(refreshSignal?.aborted, true);
  assert.equal(keys.has("radius"), false);
});

test("Radius session shutdown restores the default catalog after clearing named auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("radius")] });
  const { keys, registry } = runtimeHarness(mock);
  const refreshKeys: Array<string | undefined> = [];
  registry.refresh = async () => {
    refreshKeys.push(keys.get("radius"));
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await waitForTest(() => keys.get("radius") === "access-radius");
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  assert.equal(keys.has("radius"), false);
  assert.deepEqual(refreshKeys, ["access-radius", undefined]);
});

test("Kimi named OAuth displaces default auth with its Bearer header and restores it", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("kimi-coding", {
    headers: { authorization: "Bearer default", Existing: "yes" },
  });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: registry,
  });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("kimi-coding"));

  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "active",
    providerId: "kimi-coding",
    accountName: "work",
  });
  assert.equal(keys.get("kimi-coding"), "pi-accounts-header-auth");
  assert.deepEqual(mock.providers.get("kimi-coding"), {
    headers: { Existing: "yes", Authorization: "Bearer access-kimi" },
  });

  await store.updateProvider("kimi-coding", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "kimi-coding",
  });
  assert.equal(keys.has("kimi-coding"), false);
  assert.deepEqual(mock.providers.get("kimi-coding"), {
    headers: { authorization: "Bearer default", Existing: "yes" },
  });
});

test("Kimi named auth resolves through Pi with the selector and Bearer header", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
    },
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const model = registry.find("kimi-coding", "k3");
  assert.ok(model);
  const { ctx } = createMockContext({ model, modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("kimi-coding"));

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: true,
    apiKey: "pi-accounts-header-auth",
    headers: { Authorization: "Bearer access-kimi" },
    env: undefined,
  });

  await store.updateProvider("kimi-coding", (state) => ({ ...state, active: undefined }));
  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "inactive");
  assert.equal(registry.getRegisteredProviderConfig("kimi-coding"), undefined);
});

test("Kimi session shutdown cancels ownership and restores default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("kimi-coding", { headers: { Existing: "yes" } });
  accountsExtension(mock.pi, { store, providers: [fakeProvider("kimi-coding")] });
  const { keys, registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: registry,
    sessionManager,
  });

  await startSessionAndWaitForCurrentProvider(mock, ctx);
  assert.equal(keys.get("kimi-coding"), "pi-accounts-header-auth");
  assert.equal(collectCredentialOffers(mock, sessionManager, "kimi-coding")[0]?.access, "access-kimi");
  assert.deepEqual(mock.providers.get("kimi-coding"), {
    headers: { Existing: "yes", Authorization: "Bearer access-kimi" },
  });

  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  assert.equal(keys.has("kimi-coding"), false);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "kimi-coding"), []);
  assert.deepEqual(mock.providers.get("kimi-coding"), { headers: { Existing: "yes" } });
});

test("Kimi malformed header auth fails closed without retaining a named Bearer token", async () => {
  const invalidAuth: ModelAuth[] = [
    {},
    { headers: { Authorization: "" } },
    { headers: { Authorization: "Bearer token\r\nInjected: yes" } },
    { headers: { Authorization: "Bearer first", authorization: "Bearer second" } },
    { apiKey: "unexpected", headers: { Authorization: "Bearer token" } },
  ];
  for (const auth of invalidAuth) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
      },
    });
    const mock = createMockPi();
    const { keys, registry } = runtimeHarness(mock);
    const { ctx } = createMockContext({
      model: { provider: "kimi-coding", id: "k3" },
      modelRegistry: registry,
    });
    const kimi = fakeProvider("kimi-coding");
    kimi.oauth.toAuth = async () => auth;
    const coordinator = new RuntimeAuthCoordinator(kimi);

    const result = await ensureStoredSelection(coordinator, ctx, store);
    assert.equal(result.status, "error");
    assert.equal(keys.get("kimi-coding"), FAIL_CLOSED_API_KEY);
    assert.equal(JSON.stringify(mock.providers.get("kimi-coding") ?? {}).includes("Bearer access-kimi"), false);
  }
});

test("providers without account-specific overlays leave existing registrations untouched", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("claude") } },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("anthropic", { headers: { Existing: "yes" } });
  const registrationsBefore = mock.providerRegistrations.length;
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("anthropic"));
  const { registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.equal(mock.providerRegistrations.length, registrationsBefore);
  assert.deepEqual(mock.providers.get("anthropic"), { headers: { Existing: "yes" } });
});

test("GitHub Copilot activation applies its endpoint and available model projection, then restores config", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "enterprise",
        accounts: {
          enterprise: credential("copilot", {
            enterpriseUrl: "github.example.com",
            availableModelIds: ["allowed"],
          }),
        },
      },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("github-copilot", { headers: { Existing: "yes" } });
  const provider = fakeProvider("github-copilot", {
    baseUrl: "https://copilot-api.github.example.com",
    headers: { Account: "enterprise" },
  });
  const coordinator = new RuntimeAuthCoordinator(provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(result, {
    status: "active",
    providerId: "github-copilot",
    accountName: "enterprise",
  });
  assert.equal(keys.get("github-copilot"), "access-copilot");
  const projected = mock.providers.get("github-copilot") as {
    headers: Record<string, string>;
    baseUrl: string;
    models: Array<{ id: string }>;
  };
  assert.deepEqual(projected.headers, { Existing: "yes", Account: "enterprise" });
  assert.equal(projected.baseUrl, "https://copilot-api.github.example.com");
  assert.deepEqual(
    projected.models.map((model) => model.id),
    ["allowed"],
  );

  await store.updateProvider("github-copilot", (state) => ({ ...state, active: undefined }));
  await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(mock.providers.get("github-copilot"), { headers: { Existing: "yes" } });
  assert.equal(keys.has("github-copilot"), false);
});

test("Copilot account switches rebuild model filtering from the complete pre-overlay catalog", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "first",
        accounts: {
          first: credential("first", { availableModelIds: ["allowed"] }),
          second: credential("second", { availableModelIds: ["blocked"] }),
        },
      },
    },
  });
  const mock = createMockPi();
  const provider = fakeProvider("github-copilot", { baseUrl: "https://api.copilot.example" });
  const coordinator = new RuntimeAuthCoordinator(provider);
  const { registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(
    (mock.providers.get("github-copilot") as { models: Array<{ id: string }> }).models.map((model) => model.id),
    ["allowed"],
  );
  await store.updateProvider("github-copilot", (state) => ({ ...state, active: "second" }));
  await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(
    (mock.providers.get("github-copilot") as { models: Array<{ id: string }> }).models.map((model) => model.id),
    ["blocked"],
  );
});

test("unsafe provider endpoints and malformed model metadata fail closed", async () => {
  for (const mode of ["endpoint", "models"] as const) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        "github-copilot": {
          active: "work",
          accounts: {
            work: credential("copilot", {
              ...(mode === "models" ? { availableModelIds: [1] } : {}),
            }),
          },
        },
      },
    });
    const provider = fakeProvider("github-copilot", {
      baseUrl: mode === "endpoint" ? "http://token-stealer.invalid" : undefined,
    });
    const mock = createMockPi();
    const coordinator = new RuntimeAuthCoordinator(provider);
    const { registry, keys } = runtimeHarness(mock);
    const { ctx } = createMockContext({ modelRegistry: registry });

    assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "error");
    assert.equal(keys.get("github-copilot"), FAIL_CLOSED_API_KEY);
  }
});

test("expired credentials refresh with a concrete signal and activate", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { work: { ...credential("expired"), expires: 1 } },
      },
    },
  });
  const provider = fakeProvider("anthropic");
  let refreshSignal: AbortSignal | undefined;
  provider.oauth.refresh = async (current, signal) => {
    refreshSignal = signal;
    if (!signal) throw new Error("Missing OAuth refresh signal");
    return {
      ...current,
      access: "access-refreshed",
      expires: Date.now() + 60 * 60 * 1000,
    };
  };
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);

  assert.deepEqual(result, {
    status: "active",
    providerId: "anthropic",
    accountName: "work",
  });
  assert.ok(refreshSignal instanceof AbortSignal);
  assert.equal(refreshSignal.aborted, false);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-refreshed");
  assert.equal(keys.get("anthropic"), "access-refreshed");
});

test("refresh invalidation rejects stale credentials and rotates the signal", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { work: { ...credential("expired"), expires: 1 } },
      },
    },
  });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const signals: Array<AbortSignal | undefined> = [];
  const provider = fakeProvider("anthropic");
  provider.oauth.refresh = async (current, signal) => {
    signals.push(signal);
    if (signals.length === 1) {
      notifyStarted();
      await firstRelease;
      return {
        ...current,
        access: "access-stale",
        expires: Date.now() + 60 * 60 * 1000,
      };
    }
    return {
      ...current,
      access: "access-fresh",
      expires: Date.now() + 60 * 60 * 1000,
    };
  };
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const staleActivation = ensureStoredSelection(coordinator, ctx, store);
  await started;
  coordinator.invalidate(ctx);
  releaseFirst();
  const staleResult = await staleActivation;
  const freshResult = await ensureStoredSelection(coordinator, ctx, store);

  assert.equal(staleResult.status, "inactive");
  assert.deepEqual(freshResult, {
    status: "active",
    providerId: "anthropic",
    accountName: "work",
  });
  assert.equal(signals.length, 2);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[0].aborted, true);
  assert.ok(signals[1] instanceof AbortSignal);
  assert.equal(signals[1].aborted, false);
  assert.notEqual(signals[0], signals[1]);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-fresh");
  assert.equal(keys.get("anthropic"), "access-fresh");
});

test("invalid refreshed credentials fail closed instead of escaping storage validation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { work: { ...credential("expired"), expires: 1 } },
      },
    },
  });
  const provider = fakeProvider("anthropic");
  provider.oauth.refresh = async () => ({
    type: "oauth",
    access: "",
    refresh: "rotated-secret",
    expires: Date.now() + 60_000,
  });
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-expired");
});

test("fail-closed runtime keys are attempted even when a provider overlay is rejected", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": {
        active: "work",
        accounts: { work: credential("codex") },
      },
    },
  });
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(fakeProvider("openai-codex"));
  const { registry, keys } = runtimeHarness(mock);
  registry.registerProvider = () => {
    throw new Error("overlay rejected");
  };
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
});
