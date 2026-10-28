import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, test } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { QuotaRecovery, type RecoveryResult } from "../src/quota-recovery.js";
import { OpenAISelection, type SharedSelection } from "../src/shared-selection.js";
import { FileAccountStorageBackend } from "../src/storage.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "accounts-process-election-"));
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const cache = join(repository, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const artifacts = await mkdtemp(join(cache, "accounts-election-"));
  const worker = join(artifacts, "worker.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/quota-worker.ts", import.meta.url))],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const store = new AccountStore(new FileAccountStorageBackend(join(directory, "accounts.json")));
  const selection = new OpenAISelection(store);
  await store.updateProvider("openai", () => ({
    active: "a",
    accounts: Object.fromEntries(
      ["a", "b"].map((name) => [
        name,
        {
          type: "oauth",
          access: `synthetic-${name}`,
          refresh: `refresh-${name}`,
          expires: Date.now() + 3_600_000,
        },
      ]),
    ),
  }));
  const failed = await selection.ensure();
  assert.equal(failed.account, "a");
  let probes = 0;
  type Actor = {
    child: ChildProcess;
    closed: Promise<unknown[]>;
    ready: Promise<void>;
    probe: Promise<void>;
    result: Promise<RecoveryResult>;
    run: (options?: {
      hold?: boolean;
      timeoutMs?: number;
      quota?: boolean;
      retryToken?: string;
      failed?: SharedSelection;
      continuation?: string;
    }) => boolean;
  };
  const children: Actor[] = [];
  function start(): Actor {
    const child = spawn(process.execPath, [worker], {
      cwd: dirname(worker),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const closed = once(child, "close");
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let resolveProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    const result = new Promise<RecoveryResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("message", (value: unknown) => {
        const message = value as { kind?: string; result?: RecoveryResult };
        if (message.kind === "ready") resolveReady();
        else if (message.kind === "probe") {
          probes++;
          resolveProbe();
        } else if (message.kind === "result" && message.result) resolve(message.result);
        else reject(new Error("Unexpected recovery worker message"));
      });
      child.on("close", (code) => {
        if (code !== 0) reject(new Error("Recovery worker exited unexpectedly"));
      });
    });
    // A deliberately killed representative is asserted by the survivor results.
    void result.catch(() => {});
    const instance = {
      child,
      closed,
      ready,
      probe,
      result,
      run: (options: Parameters<Actor["run"]>[0] = {}) =>
        child.send({ directory, failed, timeoutMs: 5_000, hold: false, quota: false, ...options }),
    };
    children.push(instance);
    return instance;
  }
  return {
    store,
    selection,
    retryToken: () =>
      new QuotaRecovery(store, selection, new FileAccountStorageBackend(join(directory, "recovery.json"))).retryToken(
        failed,
      ),
    actors: Array.from({ length: 4 }, () => start()),
    probes: () => probes,
    cleanup: async () => {
      for (const instance of children)
        if (instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill();
      await Promise.all(children.map((instance) => instance.closed));
      await rm(directory, { recursive: true, force: true });
      await rm(artifacts, { recursive: true, force: true });
    },
  };
}

let h: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  h = await fixture();
  await Promise.all(h.actors.map((actor) => actor.ready));
});
afterEach(async () => {
  await h?.cleanup();
});

test("independent processes elect one representative and coalesce a late failure", async () => {
  const actors = h.actors.slice(0, 3);
  const late = h.actors[3];
  assert.ok(late);
  for (const actor of actors) actor.run();
  const results = await Promise.all(actors.map((actor) => actor.result));
  assert.equal(h.probes(), 1, JSON.stringify(results));
  assert.ok(results.every((result) => result.status === "ready"));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal((await h.selection.ensure()).account, "b");
  late.run();
  assert.deepEqual(await late.result, results[0]);
  assert.equal(h.probes(), 1);
  await Promise.all([...actors, late].map((actor) => actor.closed));
});

test("new requests in independent processes elect just one fresh representative after a stopped round", async () => {
  const first = h.actors[0];
  const actors = h.actors.slice(1, 3);
  assert.ok(first);
  first.run({ quota: true });
  assert.equal((await first.result).status, "stopped");
  assert.equal(h.probes(), 1);
  const token = await h.retryToken();
  assert.ok(token);
  for (const actor of actors) actor.run({ retryToken: token });
  const results = await Promise.all(actors.map((actor) => actor.result));
  assert.equal(results[0]?.status, "ready");
  assert.deepEqual(results[0], results[1]);
  assert.equal(h.probes(), 2);
  assert.equal((await h.selection.ensure()).account, "b");
  await Promise.all([first, ...actors].map((actor) => actor.closed));
});

test("independent processes resume one sweep without revisiting earlier candidates", async () => {
  await h.store.updateProvider("openai", (state) => ({
    ...state,
    accounts: {
      ...state.accounts,
      c: {
        type: "oauth",
        access: "synthetic-c",
        refresh: "refresh-c",
        expires: Date.now() + 3_600_000,
        piAccountsGeneration: "c",
      },
    },
  }));
  const first = h.actors[0];
  const leader = h.actors[1];
  const waiter = h.actors[2];
  const late = h.actors[3];
  assert.ok(first && leader && waiter && late);
  first.run();
  const ready = await first.result;
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const failed = await h.selection.ensure();
  assert.equal(failed.account, "b");
  leader.run({ failed, continuation: ready.round });
  await leader.probe;
  waiter.run({ failed, continuation: ready.round });
  const [result, shared] = await Promise.all([leader.result, waiter.result]);
  assert.equal(result.status, "ready");
  assert.deepEqual(shared, result);
  assert.equal((await h.selection.ensure()).account, "c");
  assert.equal(h.probes(), 2);
  late.run({ failed, continuation: ready.round });
  assert.deepEqual(await late.result, result);
  assert.equal(h.probes(), 2);
});

test("a dead representative stops waiters at its deadline without another probe", async () => {
  const leader = h.actors[0];
  const waiter = h.actors[1];
  assert.ok(leader && waiter);
  leader.run({ hold: true, timeoutMs: 500 });
  await leader.probe;
  waiter.run({ timeoutMs: 500 });
  leader.child.kill();
  assert.equal((await waiter.result).status, "stopped");
  assert.equal(h.probes(), 1);
  assert.equal((await h.selection.ensure()).account, "a");
  await waiter.closed;
});
