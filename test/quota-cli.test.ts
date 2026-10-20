import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, test } from "vitest";

let directory: string;
let child: ChildProcess;
let closed: Promise<unknown[]>;
let respond: () => void;
let result: Promise<unknown>;
let requests = 0;
let input = "";
let received!: () => void;
const requestReceived = new Promise<void>((done) => {
  received = done;
});
const server = createServer((request, response) => {
  requests++;
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    input += chunk;
  });
  request.on("end", () => {
    const item = {
      type: "message",
      id: "offline",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    };
    const events = [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item] } },
    ];
    respond = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    };
    received();
  });
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "accounts-cli-probe-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const packageRoot = root;
  const staged = join(directory, "extension");
  await cp(join(packageRoot, "dist"), join(staged, "dist"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies)) {
    const target = join(staged, "node_modules", name);
    await mkdir(resolve(target, ".."), { recursive: true });
    await symlink(join(root, "node_modules", name), target, "junction");
  }
  await assert.rejects(access(join(staged, "node_modules/@earendil-works")), { code: "ENOENT" });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    id: "offline",
    name: "Offline",
    provider: "openai",
    api: "openai-responses",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 32,
  };
  const chunks = join(staged, "dist/chunks");
  const probe = (await readdir(chunks)).find((name) => /^quota-probe-.*\.ts$/u.test(name));
  assert.ok(probe);
  const extension = join(directory, "fixture.ts");
  await writeFile(
    extension,
    `import {runProbeProcess} from ${JSON.stringify(pathToFileURL(join(chunks, probe)).href)};
export default function(pi) {
  const requested = new Promise(resolve => process.once('message', resolve));
  pi.on('session_start', () => process.send({kind:'ready'}));
  pi.registerCommand('fixture', {description:'Offline probe', handler:async()=>{
    await requested;
    try { process.send({kind:'result',value:await runProbeProcess(${JSON.stringify(model)},{apiKey:'offline-synthetic-access'},new AbortController().signal)},()=>process.disconnect()); }
    catch { process.send({kind:'result',value:'failed'},()=>process.disconnect()); }
  }});
}`,
  );
  const hostRoot = getPackageDir();
  const host = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
  child = spawn(
    process.execPath,
    [
      join(hostRoot, host.bin.pi),
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-mcp",
      "--no-session",
      "--no-tools",
      "--no-approve",
      "-e",
      extension,
      "-p",
      "/fixture",
    ],
    {
      cwd: directory,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent") },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  closed = once(child, "close");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8192);
  });
  const ready = new Promise<void>((done, reject) => {
    child.on("message", (value) => {
      if ((value as { kind?: string }).kind === "ready") done();
    });
    child.once("close", () => reject(new Error(`CLI exited before readiness: ${stderr}`)));
    child.once("error", reject);
  });
  result = new Promise((done, reject) => {
    child.on("message", (value) => {
      if ((value as { kind?: string }).kind === "result") done((value as { value: unknown }).value);
    });
    child.once("close", () => reject(new Error(`CLI exited without result: ${stderr}`)));
    child.once("error", reject);
  });
  void result.catch(() => {});
  await ready;
  child.send({ kind: "run" });
  await Promise.race([
    requestReceived,
    result.then(() => {
      throw new Error("Probe completed without making a request.");
    }),
  ]);
});

afterAll(async () => {
  child?.kill();
  if (closed) await closed;
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("bundled CLI runs the generated isolated probe without extension-local Pi peers", async () => {
  respond();
  assert.deepEqual({ result: await result, requests }, { result: "pong", requests: 1 });
  const [code] = await closed;
  assert.equal(code, 0);
  const body = JSON.parse(input);
  assert.match(JSON.stringify(body.input), /ping/u);
  assert.doesNotMatch(input, /AGENTS|PLAN|original conversation|powershell/u);
  assert.equal(body.tools, undefined);
});
