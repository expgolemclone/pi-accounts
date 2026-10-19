import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import accountsExtension from "../src/accounts.js";
import type { AccountActivationResult } from "../src/accounts-protocol.js";
import type { AccountProviderAdapter } from "../src/oauth.js";
import { OpenAISelection } from "../src/shared-selection.js";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";
import { createMockContext, createMockPi } from "./support.js";

isolateAccountEnvironment();

for (const providerId of ["anthropic", "openai"] as const) {
  for (const olderPath of ["menu", "protocol"] as const) {
    test(`${providerId}: older ${olderPath} activation cannot supersede the other path`, async () => {
      const store = new AccountStore(new InMemoryAccountStorageBackend());
      await store.updateProvider(providerId, () => ({
        active: "initial",
        accounts: Object.fromEntries(
          ["initial", "older", "newer"].map((name) => [name, { type: "api_key", key: `synthetic-${name}` }]),
        ),
      }));
      const provider: AccountProviderAdapter = {
        id: providerId,
        displayName: "Fixture",
        requiresApiKeyBridge: false,
        supportsApiKey: true,
        runtimeAuthMode: "api-key",
        oauth: {
          login: async () => {
            throw new Error("Unexpected login");
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      };
      const mock = createMockPi();
      accountsExtension(mock.pi, { store, providers: [provider] });
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const registry = new ModelRegistry(runtime);
      const manager = SessionManager.inMemory(process.cwd());
      const choices: string[] = [];
      let pauseNextRead = false;
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = store.readAsync.bind(store);
      store.readAsync = async (signal) => {
        if (pauseNextRead) {
          pauseNextRead = false;
          entered();
          await gate;
        }
        return read(signal);
      };
      const { ctx } = createMockContext({
        mode: "rpc",
        hasUI: true,
        sessionManager: manager,
        modelRegistry: registry,
        model: registry.getAll().find((model) => model.provider === providerId),
        select: async (_title: string, options: string[]) => {
          const choice = choices.shift();
          assert.ok(choice && options.includes(choice));
          if (choice === "older") pauseNextRead = true;
          return choice;
        },
      });
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
      const menu = (account: string) => {
        choices.push("Switch Fixture account", account);
        return Promise.resolve(mock.commands.get("accounts")?.handler("", ctx));
      };
      const protocol = (account: string) =>
        new Promise<AccountActivationResult>((reply) => {
          mock.eventBus.emit("accounts:activation:v1", { session: manager, provider: providerId, account, reply });
        });
      if (olderPath === "protocol") pauseNextRead = true;
      const older = olderPath === "menu" ? menu("older") : protocol("older");
      try {
        await started;
        if (olderPath === "menu") assert.equal((await protocol("newer")).status, "active");
        else await menu("newer");
        assert.equal(await registry.getApiKeyForProvider(providerId), "synthetic-newer");
        release();
        const previous = await older;
        if (olderPath === "protocol") {
          assert.equal((previous as AccountActivationResult).status, "error");
          assert.equal((previous as { code: string }).code, "activation_superseded");
        }
        assert.equal(await registry.getApiKeyForProvider(providerId), "synthetic-newer");
        if (providerId === "openai") assert.equal((await new OpenAISelection(store).ensure()).account, "newer");
        else {
          const entry = manager
            .getEntries()
            .filter((entry) => entry.type === "custom")
            .at(-1);
          assert.ok(entry);
          assert.equal((entry.data as { providers: { anthropic: string } }).providers.anthropic, "newer");
        }
      } finally {
        release();
        await older;
        await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
      }
    });
  }
}
