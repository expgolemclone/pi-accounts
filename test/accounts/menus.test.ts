import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { initTheme, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import accountsExtension, { AccountStore } from "../../src/accounts.js";
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

test("accounts registers only the interactive /accounts command and lifecycle hooks", () => {
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store: new AccountStore(new InMemoryAccountStorageBackend()),
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });

  assert.deepEqual([...mock.commands.keys()].sort(), ["accounts"]);
  assert.deepEqual([...mock.events.keys()].sort(), [
    "before_agent_start",
    "model_select",
    "session_shutdown",
    "session_start",
    "turn_start",
  ]);
});

test("accounts command ignores arguments but requires interactive UI", async () => {
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store: new AccountStore(new InMemoryAccountStorageBackend()),
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { ctx, notifications } = createMockContext({ hasUI: false });

  await mock.commands.get("accounts")?.handler("switch anthropic work", ctx);

  assert.match(notifications.at(-1)?.message ?? "", /requires interactive UI/);
  assert.equal(notifications.at(-1)?.level, "error");
});

for (const providerId of ["anthropic", "openai"] as const) {
  for (const mode of ["tui", "rpc"] as const) {
    test(`${mode} ${providerId} activation rejects an account removed after menu selection`, async () => {
      const store = new AccountStore(new InMemoryAccountStorageBackend());
      await store.updateProvider(providerId, () => ({
        active: "initial",
        accounts: { initial: credential("initial"), removed: credential("removed") },
      }));
      const provider = fakeProvider(providerId);
      const mock = createMockPi();
      accountsExtension(mock.pi, { store, providers: [provider] });
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const registry = new ModelRegistry(runtime);
      const choices = [`Switch ${provider.displayName} account`, "removed"];
      const sessionManager = createTestSessionManager();
      const { ctx, notifications } = createMockContext({
        mode,
        hasUI: true,
        sessionManager,
        model: registry.getAll().find((model) => model.provider === providerId),
        modelRegistry: registry,
        select: async (_title: string, options: string[]) => {
          const choice = choices.shift();
          assert.ok(choice && options.includes(choice));
          if (choice === "removed") {
            await store.updateProvider(providerId, (state) => ({
              ...state,
              accounts: { initial: credential("initial") },
            }));
          }
          return choice;
        },
      });
      await startSessionAndWaitForCurrentProvider(mock, ctx);
      try {
        await mock.commands.get("accounts")?.handler("", ctx);
        assert.match(notifications.at(-1)?.message ?? "", /was not found/u);
        assert.equal(await registry.getApiKeyForProvider(providerId), "access-initial");
        assert.equal((await store.readProviderAsync(providerId)).active, "initial");
        if (providerId !== "openai") assert.equal(latestSessionSelections(sessionManager)[providerId], "initial");
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
      }
    });
  }
}

test("accounts menu summarizes all supported providers and prioritizes current provider switch", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { personal: credential("personal"), work: credential("work") },
      },
      "openai-codex": { accounts: { codex: credential("codex") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [
      fakeProvider("openai-codex"),
      fakeProvider("anthropic"),
      fakeProvider("github-copilot"),
      fakeProvider("kimi-coding"),
      fakeProvider("meta"),
      fakeProvider("openai"),
      fakeProvider("openrouter"),
      fakeProvider("radius"),
      fakeProvider("xai"),
    ],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /Current model:\nAnthropic \/ claude/);
  assert.match(selectCalls[0]?.title ?? "", /Anthropic: work/);
  assert.match(selectCalls[0]?.title ?? "", /OpenAI Codex: default/);
  assert.match(selectCalls[0]?.title ?? "", /GitHub Copilot: default/);
  assert.match(selectCalls[0]?.title ?? "", /Kimi For Coding: default/);
  assert.match(selectCalls[0]?.title ?? "", /Meta: default/);
  assert.match(selectCalls[0]?.title ?? "", /OpenAI: default/);
  assert.match(selectCalls[0]?.title ?? "", /OpenRouter: default/);
  assert.match(selectCalls[0]?.title ?? "", /Radius: default/);
  assert.match(selectCalls[0]?.title ?? "", /xAI: default/);
  assert.deepEqual(selectCalls[0]?.options, [
    "Switch Anthropic account",
    "Login new account",
    "Remove account",
    "Switch another provider’s account",
    "Set default account",
  ]);
});

test("accounts recovery routes to the invalid provider without dead current-provider actions", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: sessionManager.getSessionId(),
    providers: {
      anthropic: null,
      "github-copilot": null,
      "openai-codex": "missing",
    },
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /selected account is no longer available/iu);
  assert.deepEqual(selectCalls[0]?.options, [
    "Login new account",
    "Switch another provider’s account",
    "Set default account",
  ]);
});

test("accounts menu uses generic provider switch for unsupported current models", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { anthropic: { accounts: { work: credential("work") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "google\u202e", id: "gemini\u001b[31m" },
    modelRegistry: registry,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /google \/ gemini/u);
  assert.equal((selectCalls[0]?.title ?? "").includes("\u001b"), false);
  assert.equal((selectCalls[0]?.title ?? "").includes("\u202e"), false);
  assert.deepEqual(selectCalls[0]?.options, [
    "Login new account",
    "Switch provider account",
    "Remove account",
    "Set default account",
  ]);
});

test("switch another provider account selects provider before account", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { "openai-codex": { accounts: { work: credential("codex") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx, selectCalls } = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch another provider’s account", "OpenAI Codex", "work"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.equal((await store.readProviderAsync("openai-codex")).active, undefined);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "work");
  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.deepEqual(selectCalls[1]?.options, ["OpenAI Codex"]);
});

test("remove account confirms and active removal restores default provider auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { personal: credential("personal"), work: credential("work") },
      },
      "openai-codex": { accounts: { codex: credential("codex") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, confirmCalls } = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
    },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  );

  await startSessionAndWaitForCurrentProvider(mock, ctx);
  assert.equal(keys.get("anthropic"), "access-work");
  await mock.commands.get("accounts")?.handler("ignored", ctx);

  const state = await store.readProviderAsync("anthropic");
  assert.equal(state.active, undefined);
  assert.equal(state.accounts.work, undefined);
  assert.equal(state.accounts.personal?.access, "access-personal");
  assert.equal(keys.has("anthropic"), false);
  assert.match(confirmCalls[0]?.message ?? "", /Remove Anthropic account "work"/);
});
