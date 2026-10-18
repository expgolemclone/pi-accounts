import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { test } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { QuotaRecovery, type RecoveryResult } from "../src/quota-recovery.js";
import { OpenAISelection } from "../src/shared-selection.js";
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
    run: (retryToken?: string) => boolean;
  };
  const children: Actor[] = [];
  function start(hold = false, timeoutMs = 5_000, quota = false, retryToken?: string): Actor {
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
      run: (nextToken = retryToken) => child.send({ directory, failed, timeoutMs, hold, quota, retryToken: nextToken }),
    };
    children.push(instance);
    return instance;
  }
  return {
    selection,
    retryToken: () =>
      new QuotaRecovery(store, selection, new FileAccountStorageBackend(join(directory, "recovery.json"))).retryToken(
        failed,
      ),
    start,
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

test("independent processes elect one representative and coalesce a late failure", async () => {
  const h = await fixture();
  try {
    const actors = [h.start(), h.start(), h.start()];
    const late = h.start();
    await Promise.all([...actors, late].map((actor) => actor.ready));
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
  } finally {
    await h.cleanup();
  }
});

test("new requests in independent processes elect just one fresh representative after a stopped round", async () => {
  const h = await fixture();
  try {
    const first = h.start(false, 5_000, true);
    const actors = [h.start(), h.start()];
    await Promise.all([first, ...actors].map((actor) => actor.ready));
    first.run();
    assert.equal((await first.result).status, "stopped");
    assert.equal(h.probes(), 1);
    const token = await h.retryToken();
    assert.ok(token);
    for (const actor of actors) actor.run(token);
    const results = await Promise.all(actors.map((actor) => actor.result));
    assert.equal(results[0]?.status, "ready");
    assert.deepEqual(results[0], results[1]);
    assert.equal(h.probes(), 2);
    assert.equal((await h.selection.ensure()).account, "b");
    await Promise.all([first, ...actors].map((actor) => actor.closed));
  } finally {
    await h.cleanup();
  }
});

test("a dead representative stops waiters at its deadline without another probe", async () => {
  const h = await fixture();
  try {
    const leader = h.start(true, 500);
    const waiter = h.start(false, 500);
    await Promise.all([leader.ready, waiter.ready]);
    leader.run();
    await leader.probe;
    waiter.run();
    leader.child.kill();
    assert.equal((await waiter.result).status, "stopped");
    assert.equal(h.probes(), 1);
    assert.equal((await h.selection.ensure()).account, "a");
    await waiter.closed;
  } finally {
    await h.cleanup();
  }
});
