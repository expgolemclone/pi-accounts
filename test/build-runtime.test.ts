import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";

interface BuildMetadata {
  inputs?: Record<string, { imports: Array<{ path: string; kind: string; external?: boolean }> }>;
  outputs?: Record<
    string,
    {
      entryPoint?: string;
      imports?: Array<{ external?: boolean; kind?: string; path: string }>;
      inputs?: Record<string, unknown>;
    }
  >;
}

interface RuntimeBuilder {
  buildRuntime(options?: {
    outputDirectory?: string;
    validateOutput?: (outputDirectory: string) => Promise<void>;
  }): Promise<BuildMetadata>;
  validateGeneratedFiles(outputDirectory: string): Promise<void>;
  validateEagerGraph(metadata: BuildMetadata): { eagerInputs: Set<string>; eagerOutputs: Set<string> };
  publishRuntime(
    stagingDirectory: string,
    outputDirectory: string,
    operations?: { renamePath?: typeof rename },
  ): Promise<void>;
}

isolateAccountEnvironment();
const packageRoot = resolve(".");
const forbiddenEagerInputs = ["src/account-menu.ts", "src/quota-probe.ts", "src/quota/probe-worker.ts"];
const builderUrl = pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href;
async function loadBuilder(): Promise<RuntimeBuilder> {
  return (await import(builderUrl)) as RuntimeBuilder;
}
function validMetadata(): BuildMetadata {
  const outputs: NonNullable<BuildMetadata["outputs"]> = {
    "dist/index.ts": { entryPoint: "src/index.ts", imports: [], inputs: { "src/index.ts": {} } },
  };
  for (const [index, input] of forbiddenEagerInputs.entries()) {
    const path = `dist/chunks/lazy-${index}.ts`;
    outputs["dist/index.ts"].imports?.push({ path, kind: "dynamic-import" });
    outputs[path] = { entryPoint: input, imports: [], inputs: { [input]: {} } };
  }
  return { outputs };
}

test(`Pi Accounts eager graph preserves first-use boundaries and external packages`, async () => {
  const builder = await loadBuilder();
  assert.doesNotThrow(() => builder.validateEagerGraph(validMetadata()));
  for (const forbidden of forbiddenEagerInputs) {
    const metadata = validMetadata();
    requireOutput(metadata, "dist/index.ts").inputs = { [forbidden]: {} };
    assert.throws(() => builder.validateEagerGraph(metadata), /First-use implementation is eager/u);
  }
  const missingWorker = validMetadata();
  delete missingWorker.outputs?.["dist/chunks/lazy-2.ts"];
  assert.throws(() => builder.validateEagerGraph(missingWorker), /Missing first-use runtime entry/u);
  for (const kind of ["import-statement", "dynamic-import"]) {
    const metadata = validMetadata();
    requireOutput(metadata, "dist/index.ts").imports = [{ path: "dist/chunks/lazy-2.ts", kind }];
    if (kind === "import-statement")
      assert.throws(() => builder.validateEagerGraph(metadata), /First-use implementation is eager/u);
    else assert.doesNotThrow(() => builder.validateEagerGraph(metadata));
  }
  for (const path of ["dist/index.ts", "dist/chunks/dependency.ts"]) {
    const metadata = validMetadata();
    metadata.outputs ??= {};
    metadata.outputs[path] = { ...metadata.outputs[path], inputs: { "node_modules/example/index.js": {} } };
    assert.throws(() => builder.validateEagerGraph(metadata), /Bundled package input/u);
  }
});

test(`Pi Accounts runtime rejects destructive output paths and symlink escapes`, async () => {
  const builder = await loadBuilder();
  const outside = await mkdtemp(join(tmpdir(), "pi-accounts-build-outside-"));
  const linkedParent = join(packageRoot, `.pi-accounts-build-test-link-${crypto.randomUUID()}`);
  try {
    for (const outputDirectory of [
      packageRoot,
      join(packageRoot, "src"),
      join(packageRoot, "scripts"),
      join(outside, "dist"),
    ]) {
      await assert.rejects(
        builder.buildRuntime({ outputDirectory }),
        /Runtime output directory must be inside the package root/u,
      );
    }
    for (const target of [outside, join(packageRoot, "src")]) {
      await symlink(target, linkedParent, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        builder.buildRuntime({ outputDirectory: join(linkedParent, "dist") }),
        /Runtime output parent must not escape the package root through a symlink/u,
      );
      await rm(linkedParent);
    }
  } finally {
    await rm(linkedParent, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("Pi Accounts runtime is deterministic, mapped, external, and removes stale output", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-accounts-build-test-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const metadata = await builder.buildRuntime({ outputDirectory: first });
    await mkdir(join(second, "chunks"), { recursive: true });
    await writeFile(join(second, "chunks", "stale.ts"), "stale");
    await builder.buildRuntime({ outputDirectory: second });
    assert.deepEqual(await snapshotDirectory(first), await snapshotDirectory(second));
    const files = await listFiles(first);
    assert.equal(files.includes("chunks/stale.ts"), false);
    assert.ok(files.includes("index.ts"));
    assert.ok(files.includes("index.ts.map"));
    assert.equal(
      files.some((path) => path.endsWith(".js")),
      false,
    );
    assert.ok(files.some((path) => path.startsWith("chunks/") && path.endsWith(".ts")));
    for (const runtimePath of files.filter((path) => path.endsWith(".ts"))) {
      assert.match(
        await readFile(join(first, runtimePath), "utf8"),
        /^\/\/ @generated by scripts\/build-runtime\.mjs/u,
      );
      assert.ok(files.includes(`${runtimePath}.map`));
    }
    await builder.validateGeneratedFiles(first);
    const outputs = metadata.outputs ?? {};
    const externalImports = Object.values(outputs)
      .flatMap((output) => output.imports ?? [])
      .filter((imported) => !Object.hasOwn(outputs, imported.path));
    assert.ok(externalImports.length > 0, "generated extension must retain external package imports");
    for (const imported of externalImports) assert.equal(imported.external, true, imported.path);
    for (const output of Object.values(outputs)) {
      for (const input of Object.keys(output.inputs ?? {})) assert.equal(input.includes("node_modules/"), false);
    }
    assert.deepEqual((await readdir(root)).sort(), ["first", "second"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Pi Accounts failed validation cleans staging and preserves the previous runtime", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-accounts-build-test-"));
  try {
    const output = join(root, "dist");
    await mkdir(output);
    await writeFile(join(output, "previous.ts"), "previous");
    await assert.rejects(
      builder.buildRuntime({
        outputDirectory: output,
        validateOutput: async () => {
          throw new Error("injected validation failure");
        },
      }),
      /injected validation failure/u,
    );
    assert.deepEqual(await listFiles(root), ["dist/previous.ts"]);
    assert.equal(await readFile(join(output, "previous.ts"), "utf8"), "previous");
    assert.deepEqual(await readdir(root), ["dist"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Pi Accounts failed publication restores the previous runtime", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-accounts-build-test-"));
  try {
    const output = join(root, "dist");
    await mkdir(output);
    await writeFile(join(output, "previous.ts"), "previous");
    const staging = join(root, "staging");
    await mkdir(staging);
    await writeFile(join(staging, "next.ts"), "next");
    let renameCalls = 0;
    await assert.rejects(
      builder.publishRuntime(staging, output, {
        renamePath: async (source, destination) => {
          if (++renameCalls === 2) throw new Error("injected publication failure");
          await rename(source, destination);
        },
      }),
      /injected publication failure/u,
    );
    assert.deepEqual(await listFiles(root), ["dist/previous.ts", "staging/next.ts"]);
    assert.equal(await readFile(join(output, "previous.ts"), "utf8"), "previous");
    assert.deepEqual((await readdir(root)).sort(), ["dist", "staging"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

if (process.platform === "win32") {
  test("runtime publication waits for a temporary Windows directory lock without copying files", async () => {
    const builder = await loadBuilder();
    const root = await mkdtemp(join(packageRoot, ".pi-accounts-build-test-"));
    const staging = join(root, "staging");
    const output = join(root, "dist");
    await mkdir(staging);
    await writeFile(join(staging, "next.ts"), "next");
    const child = spawn(
      process.execPath,
      ["-e", 'process.send("ready"); process.on("message", () => process.exit())'],
      { cwd: staging, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    const closed = once(child, "close");
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      await once(child, "message");
      await assert.rejects(rename(staging, output), (error: NodeJS.ErrnoException) =>
        ["EBUSY", "EPERM", "EACCES"].includes(error.code ?? ""),
      );
      release = setTimeout(() => child.send("release"), 100);
      await builder.publishRuntime(staging, output);
      await closed;
      assert.deepEqual(await listFiles(root), ["dist/next.ts"]);
      assert.equal(await readFile(join(output, "next.ts"), "utf8"), "next");
    } finally {
      clearTimeout(release);
      child.kill();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  });
}

function requireOutput(metadata: BuildMetadata, path: string) {
  const output = metadata.outputs?.[path];
  assert.ok(output, `missing fixture output: ${path}`);
  return output;
}

async function snapshotDirectory(directory: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const path of await listFiles(directory)) snapshot[path] = await readFile(join(directory, path), "base64");
  return snapshot;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relativePath)));
    else if (entry.isFile()) files.push(relativePath.replaceAll("\\", "/"));
  }
  return files.sort();
}

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-accounts-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("accounts"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const notifications: string[] = [];
    const sessionId = "generated-session";
    const ctx = {
      hasUI: false,
      model: undefined,
      modelRegistry: {},
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-accounts-selection",
            data: {
              version: 1,
              sessionId,
              providers: {
                anthropic: null,
                "github-copilot": null,
                "kimi-coding": null,
                "openai-codex": null,
                openrouter: null,
                radius: null,
                xai: null,
              },
            },
          },
        ],
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    };
    const command = extension?.commands.get("accounts");
    assert.ok(command);
    await command.handler("", ctx as never);
    assert.match(notifications.at(-1) ?? "", /requires interactive UI/iu);

    const accountsFile = join(agentDir, "pi-accounts.json");
    await writeFile(
      accountsFile,
      JSON.stringify({
        version: 1,
        providers: {
          "openai-codex": {
            accounts: {
              work: {
                type: "oauth",
                access: "fixture-access",
                refresh: "fixture-refresh",
                expires: 2_000_000_000_000,
              },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const choices = ["Set default account", "OpenAI Codex", "work"];
    await command.handler("", {
      ...ctx,
      mode: "rpc",
      hasUI: true,
      ui: { ...ctx.ui, select: async () => choices.shift() },
    } as never);
    assert.equal(choices.length, 0);
    assert.equal(JSON.parse(await readFile(accountsFile, "utf8")).providers["openai-codex"].active, "work");
    assert.match(notifications.at(-1) ?? "", /new sessions: work.*unchanged/u);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
