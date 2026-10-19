import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AccountProviderId, SUPPORTED_PROVIDER_IDS } from "./oauth.js";
import { type AccountStorageBackend, FileAccountStorageBackend, InMemoryAccountStorageBackend } from "./storage.js";

export const ACCOUNTS_FILE = "pi-accounts.json";
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type StoredOAuthCredential = OAuthCredential;

export type StoredApiKeyCredential = {
  type: "api_key";
  key: string;
  access?: never;
  refresh?: never;
  expires?: never;
  [key: string]: unknown;
};

export type StoredCredential = StoredOAuthCredential | StoredApiKeyCredential;

export function credentialGeneration(credential: StoredCredential | undefined): string | undefined {
  const generation = credential?.piAccountsGeneration;
  return typeof generation === "string" && generation.length > 0 ? generation : undefined;
}

export function normalizeApiKeyCredential(key: string): StoredApiKeyCredential {
  if (!key.trim() || /[\s\p{Cc}\p{Cf}]/u.test(key)) {
    throw new Error("API key must be non-empty and contain no whitespace or control characters.");
  }
  return { type: "api_key", key };
}

function normalizeAccountCredential(value: unknown, name: string): StoredCredential {
  if (isRecord(value) && value.type === "api_key") {
    const cloned = cloneJsonValue(value, new Set(), `${name} credential`) as Record<string, unknown>;
    if (typeof cloned.key !== "string") throw new Error("API key credential is missing key.");
    normalizeApiKeyCredential(cloned.key);
    if (["access", "refresh", "expires"].some((field) => Object.hasOwn(cloned, field))) {
      throw new Error("API key credential must not contain OAuth fields.");
    }
    return cloned as StoredApiKeyCredential;
  }
  return normalizeStoredCredential(value, name);
}

export type ProviderAccountsData = {
  [key: string]: unknown;
  /** Default for sessions without a saved provider selection; not the current session account. */
  active?: string;
  accounts: Record<string, StoredCredential>;
};

export type AccountsData = {
  [key: string]: unknown;
  version: 1;
  providers: Record<string, ProviderAccountsData>;
};

export class AccountStore {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly backend: AccountStorageBackend = createDefaultBackend()) {}

  read(): AccountsData {
    return this.backend.read((current) => parseAccountsData(current));
  }

  async readAsync(signal?: AbortSignal): Promise<AccountsData> {
    return this.serialized(() => this.backend.readAsync(async (current) => parseAccountsData(current), signal), signal);
  }

  async write(data: AccountsData): Promise<void> {
    await this.updateAsync(async () => data);
  }

  async update(mutator: (data: AccountsData) => AccountsData): Promise<AccountsData> {
    return this.updateAsync(async (data) => mutator(data));
  }

  async updateAsync(
    mutator: (data: AccountsData) => Promise<AccountsData>,
    signal?: AbortSignal,
  ): Promise<AccountsData> {
    return this.serialized(
      async () =>
        this.backend.withLockAsync(async (current) => {
          const next = await mutator(parseAccountsData(current));
          return { result: normalizeAccountsData(next), next: stringifyAccountsData(next) };
        }, signal),
      signal,
    );
  }

  async readProviderAsync(providerId: AccountProviderId, signal?: AbortSignal): Promise<ProviderAccountsData> {
    const data = await this.readAsync(signal);
    return cloneProviderState(data.providers[providerId]);
  }

  async updateProvider(
    providerId: AccountProviderId,
    mutator: (state: ProviderAccountsData) => ProviderAccountsData,
  ): Promise<ProviderAccountsData> {
    return this.updateProviderAsync(providerId, async (state) => mutator(state));
  }

  async updateProviderAsync(
    providerId: AccountProviderId,
    mutator: (state: ProviderAccountsData) => Promise<ProviderAccountsData>,
    signal?: AbortSignal,
  ): Promise<ProviderAccountsData> {
    let updated = emptyProviderState();
    await this.updateAsync(async (data) => {
      updated = normalizeProviderState(await mutator(cloneProviderState(data.providers[providerId])));
      return {
        ...data,
        providers: defineOwn(data.providers, providerId, updated),
      };
    }, signal);
    return updated;
  }

  async writeRawForTest(raw: string): Promise<void> {
    await this.serialized(async () => this.backend.withLockAsync(async () => ({ result: undefined, next: raw })));
  }

  private async serialized<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.operationTail;
    let release: () => void = () => undefined;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationTail = previous.then(() => slot);
    let entered = false;
    try {
      await waitForTurn(previous, signal);
      entered = true;
      signal?.throwIfAborted();
      return await operation();
    } finally {
      if (entered) release();
      else void previous.then(release, release);
    }
  }
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () =>
      settle(() =>
        reject(
          signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"),
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    previous.then(
      () => settle(resolve),
      (error) => settle(() => reject(error)),
    );
  });
}

export function parseAccountName(input: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = input.trim();
  if (!name) return { ok: false, error: "Account name is required." };
  if (!ACCOUNT_NAME_RE.test(name)) {
    return {
      ok: false,
      error: "Account names must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.",
    };
  }
  return { ok: true, name };
}

export function parseAccountsData(raw: string | undefined): AccountsData {
  if (raw === undefined) return emptyAccountsData();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid accounts JSON. Fix or remove ${ACCOUNTS_FILE}.`);
  }
  return normalizeAccountsData(parsed);
}

function normalizeAccountsData(value: unknown): AccountsData {
  if (!isRecord(value)) throw new Error("Invalid accounts data: expected an object.");
  if (value.version !== 1) throw new Error("Invalid accounts data: version must be 1.");
  if (!isRecord(value.providers)) throw new Error("Invalid accounts data: providers must be an object.");
  const providers = Object.create(null) as Record<string, ProviderAccountsData>;
  for (const [providerId, state] of Object.entries(value.providers)) {
    if (!isAccountProviderId(providerId)) {
      throw new Error(`Invalid accounts data: unsupported provider "${providerId}".`);
    }
    Object.defineProperty(providers, providerId, {
      configurable: true,
      enumerable: true,
      value: normalizeProviderState(state),
      writable: true,
    });
  }
  return { ...value, version: 1, providers };
}

function normalizeProviderState(value: unknown): ProviderAccountsData {
  if (!isRecord(value)) throw new Error("Invalid accounts data: provider state must be an object.");
  const active = parseActiveAccount(value.active);
  if (!isRecord(value.accounts)) throw new Error("Invalid accounts data: accounts must be an object.");
  const accounts = Object.create(null) as Record<string, StoredCredential>;
  for (const [name, credential] of Object.entries(value.accounts)) {
    const parsedName = parseAccountName(name);
    if (!parsedName.ok) throw new Error(`Invalid accounts data: bad account name "${name}".`);
    Object.defineProperty(accounts, name, {
      configurable: true,
      enumerable: true,
      value: normalizeAccountCredential(credential, name),
      writable: true,
    });
  }
  const state: ProviderAccountsData = { ...value, accounts };
  if (active) state.active = active;
  else delete state.active;
  return state;
}

export function normalizeStoredCredential(value: unknown, accountName: string): StoredOAuthCredential {
  const cloned = cloneJsonValue(value, new Set(), `${accountName} credential`);
  if (!isRecord(cloned)) {
    throw new Error(`Invalid accounts data: ${accountName} credential must be an object.`);
  }
  if (cloned.type !== undefined && cloned.type !== "oauth") {
    throw new Error(`Invalid accounts data: ${accountName} credential type must be oauth.`);
  }
  if (typeof cloned.access !== "string" || !cloned.access) {
    throw new Error(`Invalid accounts data: ${accountName} credential is missing access token.`);
  }
  if (typeof cloned.refresh !== "string") {
    throw new Error(`Invalid accounts data: ${accountName} credential is missing refresh token.`);
  }
  if (typeof cloned.expires !== "number" || !Number.isFinite(cloned.expires)) {
    throw new Error(`Invalid accounts data: ${accountName} credential has invalid expiration.`);
  }
  Object.defineProperty(cloned, "type", {
    configurable: true,
    enumerable: true,
    value: "oauth",
    writable: true,
  });
  return cloned as StoredOAuthCredential;
}

function cloneJsonValue(value: unknown, seen: Set<object>, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
  }
  if (typeof value !== "object") {
    throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
  }
  if (seen.has(value)) throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => cloneJsonValue(entry, seen, `${path}[${index}]`));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(entry, seen, `${path}.${key}`),
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function stringifyAccountsData(data: AccountsData): string {
  return `${JSON.stringify(normalizeAccountsData(data), null, 2)}\n`;
}

function createDefaultBackend(): AccountStorageBackend {
  return new FileAccountStorageBackend(join(getAgentDir(), ACCOUNTS_FILE));
}

function emptyAccountsData(): AccountsData {
  return { version: 1, providers: Object.create(null) as Record<string, ProviderAccountsData> };
}

function emptyProviderState(): ProviderAccountsData {
  return { accounts: Object.create(null) as Record<string, StoredCredential> };
}

function cloneProviderState(state: ProviderAccountsData | undefined): ProviderAccountsData {
  if (!state) return emptyProviderState();
  return { ...state, accounts: defineOwnMap(state.accounts) };
}

export function defineOwnMap<T>(source: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null), source) as Record<string, T>;
}

export function defineOwn<T>(source: Record<string, T>, name: string, value: T): Record<string, T> {
  const next = defineOwnMap(source);
  Object.defineProperty(next, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return next;
}

export function getOwnCredential(
  accounts: Record<string, StoredCredential>,
  name: string,
): StoredCredential | undefined {
  return Object.hasOwn(accounts, name) ? accounts[name] : undefined;
}

function parseActiveAccount(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Invalid accounts data: active must be a string.");
  const parsed = parseAccountName(value);
  if (!parsed.ok) throw new Error("Invalid accounts data: active account name is invalid.");
  return parsed.name;
}

function isAccountProviderId(value: string): value is AccountProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export { InMemoryAccountStorageBackend };
