import assert from "node:assert/strict";
import {
  type AnyModel,
  type Api,
  envApiKeyAuth,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  lazyStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import type { AccountProviderAdapter, AccountProviderId } from "../src/oauth.js";
import { RuntimeAuthCoordinator } from "../src/runtime-auth.js";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";
import { createMockContext } from "./support.js";

isolateAccountEnvironment();
const credential = {
  type: "oauth" as const,
  access: "offline-access",
  refresh: "offline-refresh",
  expires: 2_000_000_000_000,
};
const metadata = {
  promptCache: { short: 300 },
  inputLimits: { images: { resize: { maxWidth: 1111 } } },
  samplingParams: { temperature: 0.1 },
  samplingParamsByThinkingLevel: { off: { temperature: 0.2 } },
};

async function fixture(id: AccountProviderId = "github-copilot") {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const builtin = registry.getProvider(id);
  const model = registry.getAll().find((item) => item.provider === id);
  assert.ok(builtin && model);
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider(id, () => ({ accounts: { work: credential } }));
  const adapter: AccountProviderAdapter = {
    id,
    displayName: id,
    requiresApiKeyBridge: id === "openai-codex",
    runtimeAuthMode: id === "kimi-coding" ? "authorization-header" : "api-key",
    oauth: {
      login: async () => credential,
      refresh: async (value) => value,
      toAuth: async (value) => ({
        ...(id === "kimi-coding" ? {} : { apiKey: value.access }),
        baseUrl: "https://selected.example.test/v1",
        headers: { ...(id === "kimi-coding" ? { Authorization: `Bearer ${value.access}` } : {}), Account: "work" },
      }),
    },
  };
  const { ctx } = createMockContext({ modelRegistry: registry, sessionManager: SessionManager.inMemory() });
  const coordinator = new RuntimeAuthCoordinator(
    adapter,
    undefined,
    id === "openai" ? () => (stream) => stream : undefined,
  );
  return { registry, model, builtin, store, adapter, ctx, coordinator };
}

for (const id of ["kimi-coding", "github-copilot", "openai-codex", "openai"] as const) {
  test(`${id} overlays retain native behavior, live catalogs, and the original registration`, async () => {
    const f = await fixture(id);
    let models: readonly Model<Api>[] = [{ ...f.model, ...metadata }];
    let requests = 0;
    let refreshes = 0;
    const native: Provider = {
      ...f.builtin,
      name: "Native fixture",
      auth: { ...(id === "openai-codex" ? {} : { apiKey: envApiKeyAuth("Fixture", []) }), oauth: f.builtin.auth.oauth },
      getModels() {
        assert.equal(this, native);
        return models;
      },
      getAllModels() {
        assert.equal(this, native);
        return models;
      },
      async refreshModels(context) {
        assert.equal(this, native);
        refreshes++;
        await context.publish({
          update: () => {
            models = [...models, { ...f.model, id: "new-native-model", ...metadata }];
          },
        });
      },
      filterModels(list) {
        assert.equal(this, native);
        return list;
      },
      streamSimple(model) {
        assert.equal(this, native);
        requests++;
        return lazyStream(model, async () => {
          throw new Error("offline-native-stream");
        });
      },
    };
    f.registry.registerProvider(native);
    try {
      assert.equal((await f.coordinator.ensureActive(f.ctx, f.store, "work")).status, "active");
      assert.ok(f.registry.getRegisteredNativeProvider(id));
      assert.equal(f.registry.getRegisteredProviderConfig(id), undefined);
      const selected = f.registry.find(id, f.model.id);
      assert.ok(selected);
      for (const [name, value] of Object.entries(metadata)) assert.deepEqual(Reflect.get(selected, name), value);
      assert.equal(selected.baseUrl, "https://selected.example.test/v1");
      const auth = await f.registry.getApiKeyAndHeaders(selected);
      assert.equal(auth.ok && auth.headers?.Account, "work");
      if (id === "kimi-coding") assert.equal(auth.ok && auth.headers?.Authorization, "Bearer offline-access");
      const response = await f.registry.streamSimple(selected, { messages: [] }).result();
      assert.equal(response.errorMessage, "offline-native-stream");
      assert.equal(requests, 1);
      const refreshed = await f.registry.refresh({ providers: [id], allowNetwork: false });
      assert.equal(refreshed.errors.size, 0);
      assert.ok(refreshes > 0);
      assert.ok(f.registry.find(id, "new-native-model"));
      assert.equal((await f.coordinator.ensureActive(f.ctx, f.store, null)).status, "inactive");
      if (id !== "openai") assert.equal(f.registry.getRegisteredNativeProvider(id), native);
      assert.equal(f.registry.getRegisteredProviderConfig(id), undefined);
    } finally {
      await f.coordinator.clear(f.ctx);
    }
    assert.equal(f.registry.getRegisteredNativeProvider(id), native);
  });
}

for (const registration of ["native", "config"] as const) {
  test(`${registration} filtering retains metadata and model types across account switches`, async () => {
    const f = await fixture();
    const chat = { ...f.model, ...metadata };
    const other = { ...chat, id: "other-model" };
    const classifier = {
      ...f.model,
      id: "classifier",
      type: "classifier" as const,
      api: "offline-classifier",
      inputLimits: metadata.inputLimits,
    };
    const image = {
      ...f.model,
      id: "image",
      type: "image" as const,
      api: "offline-image",
      output: ["image" as const],
    };
    const models: AnyModel[] = [chat, other, classifier, image];
    if (registration === "native") {
      f.registry.registerProvider({ ...f.builtin, getModels: () => [chat, other], getAllModels: () => models });
    } else {
      f.registry.registerProvider(f.adapter.id, { models });
    }
    const previousNative = f.registry.getRegisteredNativeProvider(f.adapter.id);
    const previousConfig = f.registry.getRegisteredProviderConfig(f.adapter.id);
    await f.store.updateProvider(f.adapter.id, () => ({
      accounts: {
        work: { ...credential, availableModelIds: [chat.id] },
        other: { ...credential, availableModelIds: [other.id] },
      },
    }));
    try {
      for (const [name, expected] of [
        ["work", chat.id],
        ["other", other.id],
      ] as const) {
        assert.equal((await f.coordinator.ensureActive(f.ctx, f.store, name)).status, "active");
        const selected = f.registry.getAll().filter((model) => model.provider === f.adapter.id);
        assert.deepEqual(
          selected.map((model) => model.id),
          [expected],
        );
        assert.ok(selected[0]);
        for (const [field, value] of Object.entries(metadata)) assert.deepEqual(Reflect.get(selected[0], field), value);
        assert.equal(f.registry.getModelsOfType("classifier", f.adapter.id)[0]?.id, classifier.id);
        assert.equal(f.registry.getModelsOfType("image", f.adapter.id)[0]?.id, image.id);
      }
    } finally {
      await f.coordinator.clear(f.ctx);
    }
    assert.equal(f.registry.getRegisteredNativeProvider(f.adapter.id), previousNative);
    assert.deepEqual(f.registry.getRegisteredProviderConfig(f.adapter.id), previousConfig);
  });
}

test("cleanup does not overwrite a native registration that superseded the overlay", async () => {
  const f = await fixture();
  const native = { ...f.builtin, name: "Original native" };
  f.registry.registerProvider(native);
  assert.equal((await f.coordinator.ensureActive(f.ctx, f.store, "work")).status, "active");
  const replacement = { ...f.builtin, name: "Replacement native" };
  f.registry.registerProvider(replacement);
  await f.coordinator.clear(f.ctx);
  assert.equal(f.registry.getRegisteredNativeProvider(f.adapter.id), replacement);
});

test("failed overlay registration restores the previous native registration", async () => {
  const f = await fixture();
  const native = { ...f.builtin, name: "Original native" };
  f.registry.registerProvider(native);
  const register = f.registry.registerProvider.bind(f.registry);
  f.registry.registerProvider = ((value: string | Provider) => {
    if (typeof value === "string" || value !== native) throw new Error("injected registration failure");
    register(value);
  }) as typeof register;
  assert.equal((await f.coordinator.ensureActive(f.ctx, f.store, "work")).status, "error");
  assert.equal(f.registry.getRegisteredNativeProvider(f.adapter.id), native);
  await f.coordinator.clear(f.ctx);
  assert.equal(f.registry.getRegisteredNativeProvider(f.adapter.id), native);
});

test("failed native restoration retains the owned overlay until cleanup can be retried", async () => {
  const f = await fixture();
  const native = { ...f.builtin, name: "Original native" };
  f.registry.registerProvider(native);
  assert.equal((await f.coordinator.ensureActive(f.ctx, f.store, "work")).status, "active");
  const applied = f.registry.getRegisteredNativeProvider(f.adapter.id);
  const register = f.registry.registerProvider.bind(f.registry);
  f.registry.registerProvider = ((value: string | Provider) => {
    if (typeof value === "string" || value === native) throw new Error("injected restoration failure");
    register(value);
  }) as typeof register;
  try {
    await assert.rejects(f.coordinator.clear(f.ctx), /injected restoration failure/);
    assert.equal(f.registry.getRegisteredNativeProvider(f.adapter.id), applied);
  } finally {
    f.registry.registerProvider = register;
    await f.coordinator.clear(f.ctx);
  }
  assert.equal(f.registry.getRegisteredNativeProvider(f.adapter.id), native);
});
