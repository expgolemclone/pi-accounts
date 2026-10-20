import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import { OPENAI_QUOTA_MESSAGE } from "../src/quota-errors.js";
import { runProbeProcess as runSourceProbe } from "../src/quota-probe.js";

const model: Model<"openai-responses"> = {
  id: "offline-fixture",
  name: "Offline fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 64,
};

function pong(response: ServerResponse, text = "pong") {
  const item = {
    id: "msg-offline",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "response-offline" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-offline", status: "completed", output: [item] } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

describe.each(["source", "bundled"])("%s probe", (mode) => {
  let runProbeProcess = runSourceProbe;
  let root: string | undefined;
  let server: ReturnType<typeof createServer>;
  let response: ServerResponse;
  let controller: AbortController;
  let operation: Promise<"pong" | "quota">;
  let body: Record<string, unknown>;
  let authorization: string | undefined;
  let requests: number;

  beforeAll(async () => {
    if (mode === "source") return;
    root = await mkdtemp(join(resolve("."), ".pi-accounts-build-test-probe-"));
    // Exercise Node's node_modules TypeScript restriction, not only source execution.
    const packageDirectory = join(root, "node_modules", "probe-fixture");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ type: "module" }));
    const outputDirectory = join(packageDirectory, "dist");
    await cp(resolve("dist"), outputDirectory, { recursive: true });
    const chunks = join(outputDirectory, "chunks");
    const probe = (await readdir(chunks)).find((name) => /^quota-probe-.*\.ts$/u.test(name));
    assert.ok(probe);
    const loaded = await createJiti(import.meta.url, { tryNative: true }).import<
      typeof import("../src/quota-probe.js")
    >(pathToFileURL(join(chunks, probe)).href);
    runProbeProcess = loaded.runProbeProcess;
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    requests = 0;
    controller = new AbortController();
    let received!: () => void;
    const requestReceived = new Promise<void>((done) => {
      received = done;
    });
    server = createServer((request, outgoing) => {
      requests++;
      if (requests > 1) {
        outgoing.writeHead(500).end();
        return;
      }
      authorization = request.headers.authorization;
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        text += chunk;
      });
      request.on("end", () => {
        body = JSON.parse(text);
        response = outgoing;
        received();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    operation = runProbeProcess({ ...model, baseUrl }, { apiKey: "offline-synthetic-access" }, controller.signal);
    // Startup belongs to the fixture; each test controls the actual provider response.
    await Promise.race([
      requestReceived,
      operation.then(() => {
        throw new Error("Probe completed without making a request.");
      }),
    ]);
  });
  afterEach(async () => {
    controller?.abort();
    await operation?.catch(() => undefined);
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((done) => server.close(() => done()));
  });

  test("fresh headless Pi probe sends only ping, no tools/history, and verifies terminal pong", async () => {
    pong(response);
    assert.equal(await operation, "pong");
    assert.equal(requests, 1);
    assert.equal(authorization, "Bearer offline-synthetic-access");
    assert.equal(body.model, model.id);
    assert.equal(body.tools, undefined);
    const input = JSON.stringify(body.input);
    assert.match(input, /ping/);
    assert.doesNotMatch(input, /AGENTS|PLAN|original conversation|powershell/);
  });

  test("probe accepts the exact message-only quota failure without retrying the request", async () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: error\ndata: ${JSON.stringify({ type: "error", message: OPENAI_QUOTA_MESSAGE })}\n\n`);
    assert.equal(await operation, "quota");
    assert.equal(requests, 1);
  });

  test("successful inference with the wrong reply is not verified pong", async () => {
    pong(response, "not pong");
    await assert.rejects(operation, /pong/);
    assert.equal(requests, 1);
  });

  for (const fixture of [
    { status: 429, message: OPENAI_QUOTA_MESSAGE, expected: "quota" },
    { status: 429, message: "Try again later", expected: "invalid" },
    { status: 503, message: "Server unavailable secret-provider-body", expected: "invalid" },
    { status: 401, message: "Bearer synthetic-access rt.synthetic-refresh", expected: "authentication" },
  ]) {
    test(`headless probe performs exactly one HTTP ${fixture.status} attempt for ${fixture.expected}`, async () => {
      response.writeHead(fixture.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: fixture.message } }));
      if (fixture.expected === "quota") assert.equal(await operation, "quota");
      else
        await assert.rejects(operation, (error: Error) => {
          assert.match(error.message, fixture.expected === "authentication" ? /authentication/ : /non-quota/);
          assert.doesNotMatch(error.message, /secret-provider-body|synthetic-access|synthetic-refresh/);
          return true;
        });
      assert.equal(requests, 1);
    });
  }

  test("a fresh probe rejects a contradictory SSE code despite SDK code loss", async () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `event: error\ndata: ${JSON.stringify({ type: "error", code: "invalid_api_key", message: OPENAI_QUOTA_MESSAGE })}\n\n`,
    );
    await assert.rejects(operation, /non-quota/);
    assert.equal(requests, 1);
  });

  test("cancelling a live probe kills its owned child and releases the operation", async () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    controller.abort();
    await assert.rejects(operation, /cancelled/);
    assert.equal(requests, 1);
  });
});
