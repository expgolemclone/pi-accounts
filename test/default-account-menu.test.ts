import assert from "node:assert/strict";
import { test } from "vitest";
import { showAccountsMenu } from "../src/account-menu.js";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import { createBuiltinProviderAdapters } from "../src/oauth.js";
import { createMockContext } from "./support.js";

const credential = {
  type: "oauth" as const,
  access: "secret-access",
  refresh: "secret-refresh",
  expires: 2_000_000_000_000,
};
const adapters = new Map(createBuiltinProviderAdapters().map((adapter) => [adapter.id, adapter]));
const handlers = {
  async login() {
    throw new Error("Unexpected login");
  },
  async switch() {
    throw new Error("Unexpected switch");
  },
  async remove() {
    throw new Error("Unexpected remove");
  },
};

async function setup() {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "alpha",
    accounts: { alpha: credential, beta: credential },
  }));
  const controller = new AbortController();
  const owner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  return { store, controller, owner };
}

for (const mode of ["tui", "rpc"] as const) {
  for (const result of ["switch", "removed", "shutdown"] as const) {
    test(`${mode} native account switch delegates ${result} to activation unless cancelled`, async () => {
      const { store, owner, controller } = await setup();
      const choices = ["Switch Anthropic account", "beta"];
      const switched: string[] = [];
      const { ctx } = createMockContext({
        mode,
        hasUI: true,
        model: { provider: "anthropic", id: "claude" },
        select: async (_title: string, options: string[], dialog?: { signal?: AbortSignal }) => {
          assert.equal(dialog?.signal, owner.signal);
          const choice = choices.shift();
          if (choice === "beta") {
            assert.deepEqual(options, ["beta", "default"]);
            if (result === "removed") {
              await store.updateProvider("anthropic", (state) => ({ ...state, accounts: { alpha: credential } }));
            }
            if (result === "shutdown") controller.abort();
          }
          return choice;
        },
      });
      await showAccountsMenu(
        ctx,
        store,
        adapters,
        { selections: { anthropic: "alpha" } },
        {
          ...handlers,
          async switch(adapter, name, signal, isCurrent) {
            assert.equal(adapter.id, "anthropic");
            assert.equal(signal, owner.signal);
            assert.equal(isCurrent(), true);
            switched.push(name);
          },
        },
        owner,
      );
      assert.deepEqual(switched, result === "shutdown" ? [] : ["beta"]);
      assert.equal(store.read().providers.anthropic?.active, "alpha");
    });
  }

  test(`${mode} removal confirmation is cancelled with its menu owner`, async () => {
    const { store, owner, controller } = await setup();
    const before = store.read();
    const choices = ["Remove account", "Anthropic · beta"];
    const { ctx } = createMockContext({
      mode,
      hasUI: true,
      select: async () => choices.shift(),
      confirm: async (_title: string, _message: string, dialog?: { signal?: AbortSignal }) => {
        assert.equal(dialog?.signal, owner.signal);
        controller.abort();
        return true;
      },
    });
    await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
    assert.equal(choices.length, 0);
    assert.deepEqual(store.read(), before);
  });
}

for (const controls of [
  "\u001b[31m",
  "\u001b]52;c;payload\u0007",
  "\u001bPpayload\u001b\\",
  "\u009b31m\u009d",
  "\u202e\u2066\u200f\r\n\t",
]) {
  test(`native menu strips terminal and direction controls ${JSON.stringify(controls)}`, async () => {
    const { store, owner } = await setup();
    let title = "";
    const { ctx } = createMockContext({
      mode: "rpc",
      hasUI: true,
      model: { provider: `google${controls}`, id: `gemini${controls}` },
      select: async (value: string) => {
        title = value;
        return undefined;
      },
    });
    await showAccountsMenu(
      ctx,
      store,
      adapters,
      {
        selections: { anthropic: "alpha" },
        error: `Recover${controls}`,
      },
      handlers,
      owner,
    );
    assert.match(title, /Current model:/);
    for (const character of title) {
      const code = character.codePointAt(0) ?? 0;
      assert.ok(code >= 32 || character === "\n");
      assert.ok(code < 127 || code > 159);
    }
    for (const control of ["\u202e", "\u2066", "\u200f"]) assert.equal(title.includes(control), false);
  });
}

for (const cancelAt of [1, 2]) {
  test(`default picker cancellation at screen ${cancelAt} does not write settings`, async () => {
    const { store, owner } = await setup();
    const before = store.read();
    const choices = ["Set default account", "Anthropic"].slice(0, cancelAt);
    const { ctx } = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async () => choices.shift(),
    });
    await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
    assert.deepEqual(store.read(), before);
  });
}

for (const failure of ["removed", "write", "shutdown"] as const) {
  test(`default picker revalidates ${failure} at the locked mutation boundary`, async () => {
    const { store, owner, controller } = await setup();
    const choices = ["Set default account", "Anthropic", "beta"];
    const update = store.updateProvider.bind(store);
    const { ctx, notifications } = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async () => {
        const choice = choices.shift();
        if (choice === "beta") {
          store.updateProvider = async (provider, mutator) => {
            if (failure === "write") throw new Error("secret-access");
            if (failure === "shutdown") controller.abort();
            if (failure === "removed")
              await update(provider, (state) => ({ ...state, accounts: { alpha: credential } }));
            return update(provider, mutator);
          };
        }
        return choice;
      },
    });
    await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
    assert.equal(store.read().providers.anthropic?.active, "alpha");
    assert.equal(
      notifications.some((notice) => notice.message.includes("secret-access")),
      false,
    );
    assert.equal(
      notifications.some((notice) => notice.level === "error"),
      failure !== "shutdown",
    );
    // A failed action does not poison the next explicit save.
    store.updateProvider = update;
    await update("anthropic", (state) => ({ ...state, active: undefined }));
    assert.equal(store.read().providers.anthropic?.active, undefined);
  });
}

for (const mode of ["tui", "rpc"] as const) {
  for (const finish of ["save", "cancel", "shutdown", "stale"] as const) {
    test(`${mode} default picker delegates ${finish} to native cancellable dialogs`, async () => {
      const { store, owner, controller } = await setup();
      const titles: string[] = [];
      const choices = ["Set default account", "Anthropic", "beta"];
      const { ctx, notifications } = createMockContext({
        mode,
        hasUI: true,
        custom: async () => {
          throw new Error("Account menus must use native dialogs");
        },
        select: async (title: string, options: string[], dialog?: { signal?: AbortSignal }) => {
          titles.push(title);
          assert.equal(dialog?.signal, owner.signal);
          const choice = choices.shift();
          if (choice === "beta") {
            assert.deepEqual(options, ["Pi built-in login", "beta"]);
            if (finish === "cancel") return undefined;
            if (finish === "shutdown") controller.abort();
            if (finish === "stale") owner.isCurrent = () => false;
          }
          return choice;
        },
      });
      await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
      assert.match(titles[2] ?? "", /Default Anthropic account/);
      assert.match(titles[2] ?? "", /Saved default: alpha/);
      assert.equal(titles.join("\n").includes("secret-access"), false);
      assert.equal(store.read().providers.anthropic?.active, finish === "save" ? "beta" : "alpha");
      assert.equal(
        notifications.some((notice) => notice.level === "error"),
        false,
      );
      if (finish === "cancel") {
        assert.match(titles[3] ?? "", /Default accounts for new sessions/);
        assert.match(titles[4] ?? "", /^Accounts/);
      }
    });
  }
}
