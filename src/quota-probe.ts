import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ModelAuth } from "@earendil-works/pi-ai";
import { type ExtensionContext, getPackageDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { type AccountStore, credentialGeneration, getOwnCredential, type StoredCredential } from "./account-store.js";
import { type AccountProviderAdapter, resolveProviderOAuth } from "./oauth.js";
import { type ProbeInput, parseProbeReply } from "./quota/probe-protocol.js";
import { QuotaRecoveryError } from "./quota-failure.js";
import { refreshAccountCredential } from "./runtime-auth.js";

// Node does not strip TypeScript inside node_modules. Only loader bootstrap is untyped;
// inference, resource isolation and IPC handling live in the typechecked worker module.
const WORKER_BOOTSTRAP = `
const { createJiti } = await import(process.argv[1]);
const worker = await createJiti(process.argv[2], { fsCache: false, moduleCache: false, tryNative: false }).import(process.argv[2]);
worker.startProbeWorker();
`;

export async function runProbeProcess(
  model: Model<Api>,
  auth: ModelAuth,
  signal: AbortSignal,
): Promise<"pong" | "quota"> {
  signal.throwIfAborted();
  if (!auth.apiKey || auth.baseUrl || (auth.headers && Object.keys(auth.headers).length)) {
    throw new QuotaRecoveryError("authentication");
  }
  let ai: string;
  let sdk: string;
  let jiti: string;
  let worker: typeof import("./quota/probe-worker.js");
  try {
    worker = await import("./quota/probe-worker.js");
    // Bundled Pi supplies virtual peer imports, not files beneath this extension.
    // Resolve public package exports from the running Node host, never install peer copies.
    const host = createJiti(join(getPackageDir(), "package.json"));
    ai = host.esmResolve("@earendil-works/pi-ai");
    sdk = host.esmResolve("@earendil-works/pi-coding-agent");
    jiti = import.meta.resolve("jiti");
  } catch {
    throw new QuotaRecoveryError("modules");
  }
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "pi-accounts-probe-")).catch(() => {
    throw new QuotaRecoveryError("storage");
  });
  try {
    return await new Promise<"pong" | "quota">((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const name of [
        "PATH",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "NODE_USE_ENV_PROXY",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
      ]) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
      }
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", WORKER_BOOTSTRAP, jiti, worker.workerModuleURL],
        {
          cwd: directory,
          env,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
        },
      );
      let ready = false;
      let reply: "pong" | "quota" | undefined;
      let failure: Error | undefined;
      let messages = 0;
      let timer = setTimeout(() => stop(new QuotaRecoveryError("startup_timeout")), 30_000);
      const stop = (error: Error) => {
        failure ??= error;
        child.kill();
      };
      const abort = () => stop(new QuotaRecoveryError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.on("message", (value: unknown) => {
        const result = parseProbeReply(value);
        if (!result || ++messages > 2) return stop(new QuotaRecoveryError("protocol"));
        if (!ready) {
          if (result.kind !== "ready") return stop(new QuotaRecoveryError("protocol"));
          ready = true;
          clearTimeout(timer);
          // Inference deadline starts only after the child readiness handshake.
          timer = setTimeout(() => stop(new QuotaRecoveryError("inference_timeout")), 60_000);
          child.send(
            {
              sdk,
              ai,
              model,
              auth: { ...auth, apiKey: auth.apiKey as string },
              directory,
            } satisfies ProbeInput,
            (error) => {
              if (error) stop(new QuotaRecoveryError("launch"));
            },
          );
        } else if (result.kind === "pong") reply = "pong";
        else if (result.kind === "quota") reply = "quota";
        else stop(new QuotaRecoveryError(result.kind === "failed" ? result.reason : "protocol"));
      });
      child.on("error", () => stop(new QuotaRecoveryError("launch")));
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure || code !== 0 || !reply) reject(failure ?? new QuotaRecoveryError("protocol"));
        else resolve(reply);
      });
    });
  } catch (error) {
    throw error instanceof QuotaRecoveryError ? error : new QuotaRecoveryError("launch");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      throw new QuotaRecoveryError("storage");
    });
  }
}

export async function probeAccount(
  store: AccountStore,
  adapter: AccountProviderAdapter,
  ctx: ExtensionContext,
  model: Model<Api>,
  name: string,
  expected: StoredCredential,
  signal: AbortSignal,
): Promise<"pong" | "quota"> {
  if (
    model.provider !== "openai" ||
    model.api !== "openai-responses" ||
    new URL(model.baseUrl).origin !== "https://api.openai.com"
  )
    throw new Error("OpenAI native probe model is unavailable.");
  const generation = credentialGeneration(expected);
  const state = await store
    .updateProviderAsync(
      "openai",
      async (current) => {
        if (!generation || credentialGeneration(getOwnCredential(current.accounts, name)) !== generation) {
          throw new Error("OpenAI candidate was replaced before probing.");
        }
        return refreshAccountCredential(current, name, adapter, ctx, Date.now(), signal);
      },
      signal,
    )
    .catch(() => {
      signal.throwIfAborted();
      throw new QuotaRecoveryError("credential");
    });
  signal.throwIfAborted();
  const credential = getOwnCredential(state.accounts, name);
  if (credential?.type !== "oauth" || credentialGeneration(credential) !== generation)
    throw new QuotaRecoveryError("credential");
  const auth = await resolveProviderOAuth(adapter, ctx)
    .toAuth(credential)
    .catch(() => {
      throw new QuotaRecoveryError("credential");
    });
  signal.throwIfAborted();
  return runProbeProcess(model, auth, signal);
}
