import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, test } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { FileAccountStorageBackend } from "../src/storage.js";

type Result = { kind: string; keys: string[]; continuations: number; text: string };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "accounts-live-sessions-"));
  const cache = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  const artifacts = await mkdtemp(join(cache, "accounts-sessions-"));
  const worker = join(artifacts, "session-worker.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/session-worker.ts", import.meta.url))],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const store = new AccountStore(new FileAccountStorageBackend(join(directory, "accounts.json")));
  await store.updateProvider("openai", () => ({
    active: "a",
    accounts: Object.fromEntries(
      ["a", "b"].map((name) => [
        name,
        {
          type: "oauth",
          access: `offline-${name}`,
          refresh: `offline-refresh-${name}`,
          expires: Date.now() + 3_600_000,
        },
      ]),
    ),
  }));
  let probes = 0;
  const actors = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, [worker], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      env: { ...process.env, PI_ACCOUNT: undefined },
    });
    const closed = once(child, "close");
    const ready = deferred<void>();
    const request = deferred<void>();
    const result = deferred<Result>();
    let failure: Error | undefined;
    child.on("error", (error) => {
      failure = error;
      ready.resolve();
      request.resolve();
      result.resolve({ kind: "failed", keys: [], continuations: 0, text: "" });
    });
    child.on("message", (value: unknown) => {
      const message = value as Result & { key?: string };
      if (message.kind === "boot") child.send(directory);
      else if (message.kind === "ready") ready.resolve();
      else if (message.kind === "request" && message.key === "a") request.resolve();
      else if (message.kind === "probe") probes++;
      else if (message.kind === "result" || message.kind === "failed") result.resolve(message);
    });
    return {
      child,
      closed,
      ready: ready.promise,
      request: request.promise,
      result: result.promise,
      check: () => {
        if (failure) throw failure;
      },
    };
  });
  return {
    actors,
    probes: () => probes,
    cleanup: async () => {
      for (const actor of actors)
        if (actor.child.exitCode === null && actor.child.signalCode === null) actor.child.kill();
      await Promise.all(actors.map((actor) => actor.closed));
      await rm(directory, { recursive: true, force: true });
      await rm(artifacts, { recursive: true, force: true });
    },
  };
}

let h: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  h = await fixture();
  await Promise.all(h.actors.map((actor) => actor.ready));
  for (const actor of h.actors) actor.check();
});
afterAll(async () => {
  await h?.cleanup();
});

test("independent Pi sessions wait for one representative, including late failures; idle sessions only adopt", async () => {
  const { actors } = h;
  const affected = actors.slice(0, 3);
  for (const actor of affected) actor.child.send("run");
  await Promise.all(affected.map((actor) => actor.request));
  affected[0]?.child.send("release");
  affected[1]?.child.send("release");
  const early = await Promise.all(affected.slice(0, 2).map((actor) => actor.result));
  assert.equal(h.probes(), 1);
  for (const result of early) {
    assert.equal(result.kind, "result");
    assert.deepEqual(result.keys, ["a", "b"]);
    assert.equal(result.continuations, 1);
    assert.equal(result.text, "recovered");
  }
  affected[2]?.child.send("release");
  const late = await affected[2]?.result;
  assert.deepEqual(late?.keys, ["a", "b"]);
  assert.equal(late?.continuations, 1);
  assert.equal(h.probes(), 1);
  const idle = actors[3];
  assert.ok(idle);
  idle.child.send("run");
  const adopted = await idle.result;
  assert.deepEqual(adopted.keys, ["b"]);
  assert.equal(adopted.continuations, 0);
  assert.equal(h.probes(), 1);
  await Promise.all(actors.map((actor) => actor.closed));
});
