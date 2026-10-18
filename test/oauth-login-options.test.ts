import assert from "node:assert/strict";
import type { LoginOptions, OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import { type AccountProviderAdapter, createBuiltinProviderAdapters, loginWithOAuthUI } from "../src/oauth.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

beforeAll(() => initTheme("dark", false));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const credential = (suffix: string): OAuthCredential => ({
  type: "oauth",
  access: `access-${suffix}`,
  refresh: `refresh-${suffix}`,
  expires: Date.now() + 60 * 60 * 1000,
});

function deviceIdRecordingProvider(seen: Array<string | undefined>): AccountProviderAdapter {
  return {
    id: "openai",
    displayName: "OpenAI",
    requiresApiKeyBridge: false,
    supportsApiKey: true,
    runtimeAuthMode: "api-key",
    oauth: {
      login: async (_interaction, options) => {
        seen.push(options?.getDeviceId?.());
        return credential("device");
      },
      refresh: async (current) => current,
      toAuth: async (current) => ({ apiKey: current.access }),
    },
  };
}

test("OAuth login supplies Pi's stable installation device ID in TUI and RPC modes", async () => {
  const seen: Array<string | undefined> = [];
  const provider = deviceIdRecordingProvider(seen);

  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  const tui = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory, 100);
      return harness.resultPromise;
    },
  });
  assert.equal((await loginWithOAuthUI(tui.ctx, provider, new AbortController().signal)).access, "access-device");

  const rpc = createMockContext({ mode: "rpc", hasUI: true });
  assert.equal((await loginWithOAuthUI(rpc.ctx, provider, new AbortController().signal)).access, "access-device");

  const expected = SettingsManager.create(process.cwd(), getAgentDir()).getOrCreateDeviceId();
  assert.match(expected, UUID);
  assert.deepEqual(seen, [expected, expected]);
});

test("lazy built-in OAuth adapters forward login options to the provider flow", async () => {
  const received: Array<LoginOptions | undefined> = [];
  const adapter = createBuiltinProviderAdapters({
    loader: async () => ({
      builtinProviders: () => [
        {
          id: "openai",
          auth: {
            oauth: {
              login: async (_interaction, options) => {
                received.push(options);
                return credential("lazy");
              },
              refresh: async (current) => current,
              toAuth: async (current) => ({ apiKey: current.access }),
            },
          },
        },
      ],
    }),
  }).find((candidate) => candidate.id === "openai");
  assert.ok(adapter);

  const options: LoginOptions = { getDeviceId: () => "00000000-0000-4000-8000-000000000000" };
  const interaction = { signal: new AbortController().signal, prompt: async () => "", notify: () => {} };
  assert.equal((await adapter.oauth.login(interaction, options)).access, "access-lazy");
  assert.deepEqual(received, [options]);
});
