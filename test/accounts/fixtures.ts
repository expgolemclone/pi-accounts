import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AccountStore, StoredOAuthCredential } from "../../src/accounts.js";
import type { AccountProviderAdapter } from "../../src/oauth.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../../src/oauth-credential-source.js";
import type { RuntimeAuthCoordinator } from "../../src/runtime-auth.js";
import { ACCOUNT_SELECTION_ENTRY_TYPE } from "../../src/session-selection.js";
import { createMockContext as createBaseMockContext, type createMockPi } from "../support.js";

export const credential = (suffix: string, extra: Record<string, unknown> = {}): StoredOAuthCredential => ({
  type: "oauth",
  access: `access-${suffix}`,
  refresh: `refresh-${suffix}`,
  expires: Date.now() + 60 * 60 * 1000,
  ...extra,
});

export function fakeProvider(
  id: AccountProviderAdapter["id"],
  options: {
    baseUrl?: string;
    headers?: Record<string, string>;
    requiresApiKeyBridge?: boolean;
  } = {},
): AccountProviderAdapter {
  const displayNames: Record<AccountProviderAdapter["id"], string> = {
    anthropic: "Anthropic",
    "github-copilot": "GitHub Copilot",
    "kimi-coding": "Kimi For Coding",
    meta: "Meta",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    openrouter: "OpenRouter",
    radius: "Radius",
    xai: "xAI",
  };
  return {
    id,
    displayName: displayNames[id],
    requiresApiKeyBridge: options.requiresApiKeyBridge ?? id === "openai-codex",
    runtimeAuthMode: id === "kimi-coding" ? "authorization-header" : "api-key",
    refreshModelCatalogAfterAuth: id === "radius",
    oauth: {
      async login() {
        return credential(`login-${id}`, id === "github-copilot" ? { availableModelIds: ["allowed"] } : {});
      },
      async refresh(current) {
        return { ...current, access: `${current.access}-refreshed`, expires: Date.now() + 60_000 };
      },
      async toAuth(current) {
        return id === "kimi-coding"
          ? {
              baseUrl: options.baseUrl,
              headers: {
                Authorization: `Bearer ${current.access}`,
                ...options.headers,
              },
            }
          : { apiKey: current.access, baseUrl: options.baseUrl, headers: options.headers };
      },
    },
  };
}

export function runtimeHarness(mock: ReturnType<typeof createMockPi>, options: { isolateProviders?: boolean } = {}) {
  const keys = new Map<string, string>();
  const providerConfigs = options.isolateProviders ? new Map(mock.providers) : mock.providers;
  const models = [
    { provider: "openai-codex", id: "codex", baseUrl: "https://codex.example" },
    { provider: "anthropic", id: "claude", baseUrl: "https://anthropic.example" },
    { provider: "github-copilot", id: "allowed", baseUrl: "https://default.copilot" },
    { provider: "github-copilot", id: "blocked", baseUrl: "https://default.copilot" },
    { provider: "kimi-coding", id: "k3", baseUrl: "https://api.kimi.com/coding" },
    { provider: "meta", id: "muse", baseUrl: "https://api.meta.ai/v1" },
    { provider: "openai", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" },
    { provider: "openrouter", id: "openrouter-model", baseUrl: "https://openrouter.ai/api/v1" },
    { provider: "radius", id: "radius-model", baseUrl: "https://radius.pi.dev" },
    { provider: "xai", id: "grok-4.3", baseUrl: "https://api.x.ai/v1" },
  ];
  const refreshCalls: Array<{ providers?: readonly string[]; allowNetwork?: boolean }> = [];
  const runtime = {
    async setRuntimeApiKey(provider: string, key: string) {
      keys.set(provider, key);
    },
    async removeRuntimeApiKey(provider: string) {
      keys.delete(provider);
    },
  };
  const registry = {
    runtime,
    getRegisteredProviderConfig: (provider: string) => providerConfigs.get(provider),
    getRegisteredNativeProvider: () => undefined,
    getModelsOfType: () => [],
    registerProvider(provider: string, config: unknown) {
      if (!options.isolateProviders) {
        mock.rawPi.registerProvider(provider, config);
        return;
      }
      const previous = providerConfigs.get(provider);
      providerConfigs.set(
        provider,
        previous && typeof previous === "object" && config && typeof config === "object"
          ? { ...previous, ...config }
          : config,
      );
    },
    unregisterProvider(provider: string) {
      if (!options.isolateProviders) {
        mock.rawPi.unregisterProvider(provider);
        return;
      }
      providerConfigs.delete(provider);
    },
    getApiKeyForProvider: async (provider: string) => keys.get(provider),
    getAll: () =>
      models.map((model) => ({
        ...model,
        name: model.id,
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      })),
    find(provider: string, id: string) {
      const model = models.find((item) => item.provider === provider && item.id === id);
      if (!model) return undefined;
      const config = providerConfigs.get(provider) as { baseUrl?: string; models?: Array<{ id: string }> } | undefined;
      if (config?.models && !config.models.some((item) => item.id === id)) return undefined;
      return { ...model, baseUrl: config?.baseUrl ?? model.baseUrl };
    },
    async getApiKeyAndHeaders(model: { provider: string }) {
      const config = providerConfigs.get(model.provider) as { headers?: Record<string, string> } | undefined;
      return { ok: true as const, apiKey: keys.get(model.provider), headers: config?.headers };
    },
    async refresh(options: { providers?: readonly string[]; allowNetwork?: boolean; signal?: AbortSignal }) {
      refreshCalls.push(options);
      return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
    },
  };
  return { keys, models, providerConfigs, refreshCalls, registry, runtime };
}

export function ensureStoredSelection(
  coordinator: RuntimeAuthCoordinator,
  ctx: Parameters<RuntimeAuthCoordinator["ensureActive"]>[0],
  store: AccountStore,
  now = Date.now(),
  ownerSignal?: AbortSignal,
) {
  const selectedAccount = store.read().providers[coordinator.provider.id]?.active ?? null;
  return coordinator.ensureActive(ctx, store, selectedAccount, now, ownerSignal);
}

export function createMockContext(overrides: Record<string, unknown> = {}) {
  return createBaseMockContext({
    sessionManager: SessionManager.inMemory(process.cwd(), { id: "test-session" }),
    ...overrides,
  });
}

export function createTestSessionManager(sessionId?: string): SessionManager {
  return SessionManager.inMemory(process.cwd(), { id: sessionId ?? randomUUID() });
}

export function latestSessionSelections(
  sessionManager: Pick<SessionManager, "getEntries">,
): Record<string, string | null> {
  const entry = sessionManager
    .getEntries()
    .filter(
      (candidate): candidate is CustomEntry =>
        candidate.type === "custom" && candidate.customType === ACCOUNT_SELECTION_ENTRY_TYPE,
    )
    .at(-1);
  const data = entry?.data as { providers?: Record<string, string | null> } | undefined;
  return data?.providers ?? {};
}

export function collectCredentialOffers(
  mock: ReturnType<typeof createMockPi>,
  session: object,
  provider: string,
): StoredOAuthCredential[] {
  const offers: StoredOAuthCredential[] = [];
  mock.eventBus.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, {
    session,
    provider,
    offer(candidate: StoredOAuthCredential) {
      offers.push(candidate);
    },
  });
  return offers;
}

export function createInteractiveAccountContext(
  overrides: Record<string, unknown> = {},
  options: {
    selections?: string[];
    inputs?: Array<string | undefined>;
    confirms?: boolean[];
  } = {},
) {
  const selections = [...(options.selections ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    ...overrides,
    select: async (title: string, values: string[]) => {
      selectCalls.push({ title, options: values });
      const selected = selections.shift();
      if (selected !== undefined) assert.ok(values.includes(selected), `Missing option: ${selected}`);
      return selected;
    },
    input: async (title: string, placeholder?: string) => {
      inputCalls.push({ title, placeholder });
      return inputs.shift();
    },
    confirm: async (title: string, message: string) => {
      confirmCalls.push({ title, message });
      return confirms.shift() ?? true;
    },
  });
  return { ...context, selectCalls, inputCalls, confirmCalls };
}

export async function waitForTest(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test state");
}

export async function startSessionAndWaitForCurrentProvider(
  mock: ReturnType<typeof createMockPi>,
  ctx: ReturnType<typeof createMockContext>["ctx"],
  event: Record<string, unknown> = {},
): Promise<void> {
  await mock.events.get("session_start")?.[0]?.(event, ctx);
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
}
