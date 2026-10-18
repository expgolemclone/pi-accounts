import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { AccountStore, type StoredCredential } from "../src/account-store.js";
import { QuotaRecoveryError } from "../src/quota-failure.js";
import { QuotaRecovery } from "../src/quota-recovery.js";
import { OpenAISelection } from "../src/shared-selection.js";
import { FileAccountStorageBackend } from "../src/storage.js";

const credential = (id: string): StoredCredential => ({
  type: "oauth",
  access: `access-${id}`,
  refresh: `refresh-${id}`,
  expires: 2_000_000_000_000,
  piAccountsGeneration: id,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture(run: (context: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "accounts-recovery-"));
  try {
    await run(await harness(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function harness(dir: string) {
  const store = new AccountStore(new FileAccountStorageBackend(join(dir, "accounts.json")));
  const selection = new OpenAISelection(store);
  await store.updateProvider("openai", () => ({
    active: "failed",
    accounts: {
      failed: credential("failed"),
      first: credential("first"),
      second: credential("second"),
    },
  }));
  const failed = await selection.ensure();
  const recoveryFile = join(dir, "recovery.json");
  const createRecovery = (timeout?: number) =>
    new QuotaRecovery(store, selection, new FileAccountStorageBackend(recoveryFile), timeout);
  return { store, selection, failed, createRecovery, recoveryFile };
}

test("reading a missing recovery token creates no runtime file or directory", async () =>
  fixture(async (h) => {
    const path = join(h.recoveryFile, "missing", "recovery.json");
    const recovery = new QuotaRecovery(h.store, h.selection, new FileAccountStorageBackend(path));
    assert.equal(await recovery.retryToken(h.failed), undefined);
    assert.equal(existsSync(h.recoveryFile), false);
  }));

test("one representative probes once; simultaneous and late failures share its result", async () =>
  fixture(async (h) => {
    const started = deferred<void>();
    const release = deferred<"pong">();
    let probes = 0;
    const probe = async () => {
      probes++;
      started.resolve();
      return release.promise;
    };
    const signal = new AbortController().signal;
    const leader = h.createRecovery().recover(h.failed, probe, signal);
    await started.promise;
    const waiter = h.createRecovery().recover(h.failed, probe, signal);
    assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    release.resolve("pong");
    const [a, b] = await Promise.all([leader, waiter]);
    assert.deepEqual(a, b);
    assert.equal(a.status, "ready");
    assert.equal(probes, 1);
    assert.deepEqual(await h.createRecovery().recover(h.failed, probe, signal), a);
    assert.equal(probes, 1);
    if (a.status === "ready") assert.equal((await h.selection.ensure()).revision, a.revision);
  }));

test("the failed account is excluded and each candidate is attempted once without inferring a reset time", async () =>
  fixture(async (h) => {
    const attempted: string[] = [];
    const result = await h.createRecovery().recover(
      h.failed,
      async (name) => {
        attempted.push(name);
        return "quota";
      },
      new AbortController().signal,
    );
    assert.equal(result.status, "stopped");
    assert.deepEqual([...attempted].sort(), ["first", "second"]);
    assert.equal(new Set(attempted).size, attempted.length);
    assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    assert.match(result.status === "stopped" ? result.message : "", /send a new request to retry/);
    assert.doesNotMatch(JSON.stringify(result), /eligible at|hours|retryAt/);
  }));

test("non-quota probe failures stop without trying more candidates", async () =>
  fixture(async (h) => {
    let probes = 0;
    const result = await h.createRecovery().recover(
      h.failed,
      async () => {
        probes++;
        throw new Error("auth or malformed pong");
      },
      new AbortController().signal,
    );
    assert.equal(result.status, "stopped");
    assert.equal(probes, 1);
  }));

for (const reason of ["modules", "initialization", "authentication", "transport", "provider", "reply"] as const) {
  test(`safe ${reason} failure is published to late waiters without another probe`, async () =>
    fixture(async (h) => {
      let probes = 0;
      const failure = new QuotaRecoveryError(reason);
      const probe = async () => {
        probes++;
        throw failure;
      };
      const signal = new AbortController().signal;
      const result = await h.createRecovery().recover(h.failed, probe, signal);
      assert.deepEqual(result, { status: "stopped", message: failure.message });
      assert.deepEqual(await h.createRecovery().recover(h.failed, probe, signal), result);
      assert.equal(probes, 1);
      assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    }));
}

test("unexpected probe exceptions cannot leak credentials or terminal controls into shared results", async () =>
  fixture(async (h) => {
    const result = await h.createRecovery().recover(
      h.failed,
      async () => {
        throw new Error("Bearer access-secret rt.refresh-secret \u001b[31m private-response");
      },
      new AbortController().signal,
    );
    assert.equal(result.status, "stopped");
    assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret|private-response|31m/);
    assert.doesNotMatch(await readFile(h.recoveryFile, "utf8"), /access-secret|refresh-secret|private-response|31m/);
  }));

test("newer manual selection wins over an in-flight successful probe", async () =>
  fixture(async (h) => {
    const started = deferred<void>();
    const release = deferred<"pong">();
    const task = h.createRecovery().recover(
      h.failed,
      async () => {
        started.resolve();
        return release.promise;
      },
      new AbortController().signal,
    );
    await started.promise;
    const manual = await h.selection.select(null);
    release.resolve("pong");
    assert.equal((await task).status, "stopped");
    assert.deepEqual(await h.selection.ensure(), manual);
  }));

test("cancellation is published to waiters and the candidate sees abort", async () =>
  fixture(async (h) => {
    const started = deferred<void>();
    const controller = new AbortController();
    let aborted = false;
    const task = h.createRecovery().recover(
      h.failed,
      async (_name, _credential, signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return "pong";
      },
      controller.signal,
    );
    await started.promise;
    const waiter = h.createRecovery().recover(
      h.failed,
      async () => {
        throw new Error("must not probe");
      },
      new AbortController().signal,
    );
    controller.abort();
    assert.equal((await task).status, "stopped");
    assert.equal((await waiter).status, "stopped");
    assert.equal(aborted, true);
  }));

test("a verified replacement revision can initiate a later recovery round", async () =>
  fixture(async (h) => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return "pong" as const;
    };
    const signal = new AbortController().signal;
    assert.equal((await h.createRecovery().recover(h.failed, probe, signal)).status, "ready");
    const replacement = await h.selection.ensure();
    assert.ok(replacement.account);
    assert.equal((await h.createRecovery().recover(replacement, probe, signal)).status, "ready");
    assert.equal(probes, 2);
  }));

test("a replaced credential prevents publication of a stale successful probe", async () =>
  fixture(async (h) => {
    const started = deferred<string>();
    const release = deferred<"pong">();
    const task = h.createRecovery().recover(
      h.failed,
      async (name) => {
        started.resolve(name);
        return release.promise;
      },
      new AbortController().signal,
    );
    const candidate = await started.promise;
    await h.store.updateProvider("openai", (state) => ({
      ...state,
      accounts: { ...state.accounts, [candidate]: credential("replacement") },
    }));
    release.resolve("pong");
    assert.equal((await task).status, "stopped");
    assert.equal((await h.selection.ensure()).revision, h.failed.revision);
    assert.equal((await h.store.readProviderAsync("openai")).accounts[candidate]?.piAccountsGeneration, "replacement");
  }));

test("a fresh native request can restart a stopped round immediately; concurrent and late failures still coalesce", async () =>
  fixture(async (h) => {
    const recovery = h.createRecovery();
    const signal = new AbortController().signal;
    assert.equal(await recovery.retryToken(h.failed, signal), undefined);
    const attempted: string[] = [];
    const quota = async (name: string) => {
      attempted.push(name);
      return "quota" as const;
    };
    const first = await recovery.recover(h.failed, quota, signal);
    assert.equal(first.status, "stopped");
    const token = await recovery.retryToken(h.failed, signal);
    assert.ok(token);
    assert.deepEqual(await recovery.recover(h.failed, quota, signal), first);
    assert.equal(attempted.length, 2);

    const started = deferred<void>();
    const release = deferred<"quota">();
    const probe = async (name: string) => {
      attempted.push(name);
      started.resolve();
      return release.promise;
    };
    const leader = recovery.recover(h.failed, probe, signal, token);
    await started.promise;
    // Capturing during an active round never authorizes restarting it afterward.
    assert.equal(await h.createRecovery().retryToken(h.failed, signal), undefined);
    const waiter = h.createRecovery().recover(h.failed, probe, signal, token);
    release.resolve("quota");
    const results = await Promise.all([leader, waiter]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(attempted.length, 4);
    assert.deepEqual(attempted.slice(2).sort(), ["first", "second"]);
    const nextToken = await recovery.retryToken(h.failed, signal);
    assert.ok(nextToken);
    assert.notEqual(nextToken, token);
    assert.deepEqual(await recovery.recover(h.failed, quota, signal, token), results[0]);
    assert.equal(attempted.length, 4);

    const success = await recovery.recover(h.failed, async () => "pong", signal, nextToken);
    assert.equal(success.status, "ready");
    assert.notEqual((await h.selection.ensure()).account, "failed");
  }));

test("a delayed waiter stops safely when a fresh request has already replaced its completed round", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<"quota">();
    const leader = h.createRecovery().recover(
      h.failed,
      async () => {
        probeStarted.resolve();
        return releaseProbe.promise;
      },
      signal,
    );
    await probeStarted.promise;
    const waiterStarted = deferred<void>();
    const releaseWaiter = deferred<void>();
    const backend = new FileAccountStorageBackend(h.recoveryFile);
    const read = backend.readAsync.bind(backend);
    backend.readAsync = async (reader, operation) => {
      waiterStarted.resolve();
      await releaseWaiter.promise;
      return read(reader, operation);
    };
    const waiter = new QuotaRecovery(h.store, h.selection, backend).recover(
      h.failed,
      async () => {
        throw new Error("Waiters must not probe");
      },
      signal,
    );
    await waiterStarted.promise;
    releaseProbe.resolve("quota");
    assert.equal((await leader).status, "stopped");
    const recovery = h.createRecovery();
    const token = await recovery.retryToken(h.failed, signal);
    const ready = await recovery.recover(h.failed, async () => "pong", signal, token);
    assert.equal(ready.status, "ready");
    releaseWaiter.resolve();
    const stale = await waiter;
    assert.equal(stale.status, "stopped");
    assert.match(stale.status === "stopped" ? stale.message : "", /superseded/);
  }));

test("old stopped records do not impose a waiting period and unknown recovery fields survive a new election", async () =>
  fixture(async (h) => {
    const signal = new AbortController().signal;
    await writeFile(
      h.recoveryFile,
      JSON.stringify({
        version: 1,
        future: { keep: true },
        rounds: {
          [h.failed.revision]: {
            owner: "old-runtime",
            startedAt: Date.now(),
            deadline: Date.now(),
            result: { status: "stopped", message: "Old five-hour result" },
          },
        },
      }),
    );
    const recovery = h.createRecovery();
    const token = await recovery.retryToken(h.failed, signal);
    assert.equal(token, "old-runtime");
    const result = await recovery.recover(h.failed, async () => "pong", signal, token);
    assert.equal(result.status, "ready");
    assert.deepEqual(JSON.parse(await readFile(h.recoveryFile, "utf8")).future, { keep: true });
  }));

test.each(["{", "[]", '{"version":2,"rounds":{}}', '{"version":1,"rounds":{"invalid":1}}'])(
  "invalid recovery files are not overwritten: %s",
  async (raw) =>
    fixture(async (h) => {
      await writeFile(h.recoveryFile, raw);
      const recovery = h.createRecovery();
      const signal = new AbortController().signal;
      await assert.rejects(recovery.retryToken(h.failed, signal));
      await assert.rejects(recovery.recover(h.failed, async () => "pong", signal));
      assert.equal(await readFile(h.recoveryFile, "utf8"), raw);
    }),
);
