import assert from "node:assert/strict";
import { test } from "vitest";
import { AccountStore, credentialGeneration, defineOwn, type StoredCredential } from "../src/account-store.js";
import { chooseOpenAIAccount, OpenAISelection, readSharedSelection } from "../src/shared-selection.js";
import { InMemoryAccountStorageBackend } from "../src/storage.js";

const credential = (id: string): StoredCredential => ({
  type: "oauth",
  access: `access-${id}`,
  refresh: `refresh-${id}`,
  expires: 2_000_000_000_000,
  piAccountsGeneration: id,
});

test("random indexing excludes only API keys and accounts already attempted in this round", () => {
  const state = {
    accounts: {
      a: credential("a"),
      b: credential("b"),
      c: credential("c"),
      key: { type: "api_key" as const, key: "sk-offline" },
    },
  };
  const draws: number[] = [];
  assert.equal(
    chooseOpenAIAccount(state, new Set(["a"]), (max) => {
      draws.push(max);
      return 1;
    }),
    "c",
  );
  assert.deepEqual(draws, [2]);
  assert.equal(
    chooseOpenAIAccount(state, new Set(["a", "b"]), () => 0),
    "c",
  );
  assert.equal(chooseOpenAIAccount(state, new Set(["a", "b", "c"])), undefined);
  assert.equal(chooseOpenAIAccount({ accounts: {} }), undefined);
  assert.equal(
    chooseOpenAIAccount(state, undefined, () => 0),
    "a",
  );
  assert.equal(chooseOpenAIAccount({ accounts: defineOwn({}, "__proto__", credential("g")) }), "__proto__");
});

test("concurrent first initialization has one shared winner; builtin selection is explicit", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("openai", () => ({ accounts: { a: credential("a"), b: credential("b") } }));
  const first = new OpenAISelection(store);
  const second = new OpenAISelection(store);
  const selections = await Promise.all([first.ensure(), second.ensure()]);
  assert.deepEqual(selections[0], selections[1]);
  const initial = selections[0];
  assert.ok(initial?.account);
  assert.ok(["a", "b"].includes(initial.account));
  const selected = await first.select(null);
  assert.ok(selected);
  assert.equal(selected.account, null);
  assert.notEqual(selected.revision, initial.revision);
  assert.deepEqual(await second.ensure(), selected);
  assert.equal((await store.readProviderAsync("openai")).active, undefined);
});

test("manual selection wins over conditional recovery; default migration and generations persist", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("openai", () => ({
    active: "work",
    future: "keep",
    accounts: {
      work: { type: "oauth", access: "a", refresh: "r", expires: 2_000_000_000_000 },
      other: credential("other"),
    },
  }));
  const selection = new OpenAISelection(store);
  const original = await selection.ensure();
  assert.equal(original.account, "work");
  const state = await store.readProviderAsync("openai");
  assert.ok(credentialGeneration(state.accounts.work));
  assert.equal(state.future, "keep");
  const manual = await selection.select("other");
  assert.equal(await selection.select("work", undefined, () => true, original.revision), undefined);
  assert.deepEqual(await selection.ensure(), manual);
  await store.updateProvider("openai", (latest) => ({
    ...latest,
    accounts: defineOwn(latest.accounts, "work", credential("replacement")),
  }));
  assert.equal(credentialGeneration((await store.readProviderAsync("openai")).accounts.work), "replacement");
  assert.equal(
    await selection.select(
      "work",
      undefined,
      () => true,
      manual?.revision,
      String(state.accounts.work?.piAccountsGeneration),
    ),
    undefined,
  );
  assert.deepEqual(readSharedSelection(await store.readProviderAsync("openai")), manual);
});
