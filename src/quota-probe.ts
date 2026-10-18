import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ModelAuth } from "@earendil-works/pi-ai";
import { type ExtensionContext, getPackageDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { type AccountStore, credentialGeneration, getOwnCredential, type StoredCredential } from "./account-store.js";
import { type AccountProviderAdapter, resolveProviderOAuth } from "./oauth.js";
import { isQuotaFailureReason, QuotaRecoveryError } from "./quota-failure.js";
import { refreshAccountCredential } from "./runtime-auth.js";

// Runs in a fresh Node process using Pi's SDK, not a nested call in the failed conversation.
// Resources, settings, credentials, tools and history are explicitly in-memory/empty.
const WORKER = `
process.once("message", async (input) => {
  let session, failure = "initialization", status;
  try {
    const sdk = await import(input.sdk);
    const ai = await import(input.ai);
    // Node does not strip .ts inside node_modules, including Pi's generated
    // JavaScript-in-.ts runtime. Use the same standard loader as Pi for this helper.
    const { createJiti } = await import(input.jiti);
    const quota = await createJiti(input.quota, { fsCache: false, moduleCache: false, tryNative: false }).import(input.quota);
    const evidence = quota.captureQuotaEvidence(async (...args) => {
      const response = await fetch(...args);
      status = response.status;
      return response;
    });
    const runtime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false,
    });
    const native = runtime.getProvider("openai");
    if (!native) throw new Error("native OpenAI provider unavailable");
    runtime.registerProvider("openai", { api: "openai-responses", streamSimple: (model, context, options) => native.streamSimple(model, context, { ...options, maxRetries: 0, fetch: evidence.fetch }) });
    await runtime.setRuntimeApiKey("openai", input.auth.apiKey);
    const resolved = await runtime.getAuth(input.model);
    failure = "authentication";
    if (resolved?.auth.apiKey !== input.auth.apiKey) throw new Error("probe auth conflict");
    for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) {
      if (name.toLowerCase() === "authorization" && value !== "Bearer " + input.auth.apiKey) throw new Error("probe header conflict");
    }
    failure = "initialization";
    const resources = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Reply to ping with exactly pong. Do not use tools.",
      getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    ({ session } = await sdk.createAgentSession({ cwd: input.directory, agentDir: input.directory,
      model: input.model, modelRuntime: runtime, resourceLoader: resources,
      tools: [], noTools: "all", thinkingLevel: "off",
      sessionManager: sdk.SessionManager.inMemory(input.directory),
      settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    }));
    failure = "transport";
    await session.prompt("ping");
    failure = "reply";
    const terminal = session.messages.filter((message) => message.role === "assistant").at(-1);
    if (!terminal) throw new Error("missing probe result");
    const text = terminal.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
    const result = terminal.stopReason === "stop" && text === "pong" && terminal.content.every((part) => part.type === "text" || part.type === "thinking")
      ? { kind: "pong" } : terminal.stopReason === "error"
        ? (evidence.limited() ?? quota.isOpenAIQuotaError(terminal.errorMessage))
          ? { kind: "quota" }
          : { kind: "failed", reason: status === 401 || status === 403 ? "authentication" : status === undefined ? "transport" : "provider" }
        : { kind: "failed", reason: "reply" };
    session.dispose(); session = undefined;
    process.send(result, () => process.disconnect());
  } catch {
    session?.dispose();
    process.send({ kind: "failed", reason: failure }, () => process.disconnect());
  }
});
process.send({ kind: "ready" });
`;

type ProbeReply = { kind?: unknown; reason?: unknown };

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
  let quota: typeof import("./quota-errors.js");
  try {
    quota = await import("./quota-errors.js");
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
      const child = spawn(process.execPath, ["--input-type=module", "--eval", WORKER], {
        cwd: directory,
        env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
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
        if (!value || typeof value !== "object" || ++messages > 2) return stop(new QuotaRecoveryError("protocol"));
        const result = value as ProbeReply;
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
              quota: quota.quotaModuleURL,
              jiti,
              model,
              auth,
              directory,
            },
            (error) => {
              if (error) stop(new QuotaRecoveryError("launch"));
            },
          );
        } else if (result.kind === "pong") reply = "pong";
        else if (result.kind === "quota") reply = "quota";
        else
          stop(
            new QuotaRecoveryError(
              result.kind === "failed" && isQuotaFailureReason(result.reason) ? result.reason : "protocol",
            ),
          );
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
