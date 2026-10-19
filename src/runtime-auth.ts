// Cohesion justification: runtime activation, provider overlays, API-key ownership, and
// verification helpers share generation-checked fail-closed invariants that are reviewed together.
import {
  type AnyModel,
  envApiKeyAuth,
  type ModelAuth,
  type OAuthCredential,
  type Provider,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StoredCredential } from "./account-store.js";
import type { AccountActivationErrorCode } from "./accounts-protocol.js";
import { EffectiveAuthConflictError, verifyModelApiKeyAuth } from "./model-auth-verification.js";
import { type AccountProviderAdapter, type AccountProviderId, resolveProviderOAuth } from "./oauth.js";
import { cloneOAuthCredential, parseCredentialRequest } from "./oauth-credential-source.js";
import type { StreamWrapper } from "./quota-tracking.js";

export const RUNTIME_FAIL_CLOSED_API_KEY = "pi-accounts-auth-failed";
const RUNTIME_HEADER_AUTH_SELECTOR = "pi-accounts-header-auth";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const SHUTDOWN_CATALOG_REFRESH_TIMEOUT_MS = 3_000;

type RuntimeAuthStorage = {
  setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void>;
  removeRuntimeApiKey(provider: string): void | Promise<void>;
};

type RuntimeOverrideState = {
  appliedApiKey?: string;
  generation: number;
  mayHaveOverride: boolean;
  operationTail: Promise<void>;
};

type RuntimeOverrideSnapshot = {
  target: RuntimeAuthStorage & object;
  state: RuntimeOverrideState;
  generation: number;
};

type RuntimeProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
type RuntimeProviderRegistration =
  | { kind: "native"; provider: Provider }
  | { kind: "config"; config: RuntimeProviderConfig };

type ProviderAccountState = {
  active?: string;
  accounts: Record<string, StoredCredential>;
};

type PendingCredentialOffer = {
  accountName: string;
  credential: StoredCredential;
  operation: number;
  session: object;
};

type ActiveCredentialOffer = {
  credential: OAuthCredential;
  session: object;
};

export type RuntimeAccountStore = {
  readProviderAsync(providerId: AccountProviderId, signal?: AbortSignal): Promise<ProviderAccountState>;
  updateProviderAsync(
    providerId: AccountProviderId,
    mutator: (state: ProviderAccountState) => Promise<ProviderAccountState>,
    signal?: AbortSignal,
  ): Promise<ProviderAccountState>;
};

export type EnsureActiveProviderAuthResult =
  | { status: "inactive"; providerId: AccountProviderId }
  | { status: "active"; providerId: AccountProviderId; accountName: string }
  | {
      status: "error";
      providerId: AccountProviderId;
      accountName: string;
      message: string;
      code?: AccountActivationErrorCode;
    };

export async function refreshAccountCredential<T extends ProviderAccountState>(
  state: T,
  name: string,
  provider: AccountProviderAdapter,
  ctx: ExtensionContext,
  now: number,
  signal: AbortSignal,
): Promise<T> {
  const current = getOwnCredential(state.accounts, name);
  if (current?.type !== "oauth" || current.expires > now + REFRESH_SKEW_MS) return state;
  signal.throwIfAborted();
  const refreshed = await resolveProviderOAuth(provider, ctx).refresh(current, signal);
  signal.throwIfAborted();
  const credential =
    provider.id === "openai" && current.piAccountsGeneration
      ? { ...refreshed, piAccountsGeneration: current.piAccountsGeneration }
      : refreshed;
  return { ...state, accounts: defineOwn(state.accounts, name, credential) };
}

export class RuntimeAuthCoordinator {
  private readonly controller: RuntimeApiKeyController;
  private readonly overlay: RuntimeProviderOverlay;
  private availableModelIds: ReadonlySet<string> | undefined;
  private refreshController = new AbortController();
  private catalogAuthIdentity: string | undefined;
  private pendingCredentialOffer: PendingCredentialOffer | undefined;
  private activeCredentialOffer: ActiveCredentialOffer | undefined;

  constructor(
    _pi: ExtensionAPI,
    readonly provider: AccountProviderAdapter,
    private readonly failClosedApiKey = RUNTIME_FAIL_CLOSED_API_KEY,
    private readonly trackRequest?: (
      ctx: ExtensionContext,
      name: string | null,
      credential: StoredCredential | undefined,
      signal: AbortSignal,
    ) => StreamWrapper | undefined,
  ) {
    this.controller = new RuntimeApiKeyController(provider.id);
    this.overlay = new RuntimeProviderOverlay(provider, failClosedApiKey);
  }

  async ensureActive(
    ctx: ExtensionContext,
    store: RuntimeAccountStore,
    selectedAccount: string | null,
    now = Date.now(),
    ownerSignal?: AbortSignal,
  ): Promise<EnsureActiveProviderAuthResult> {
    this.clearCredentialOffer();
    const operation = this.overlay.beginOperation();
    const runtimeOverride = this.controller.begin(ctx);
    const operationSignal = this.beginRefreshOperation();
    const refreshSignal = ownerSignal ? AbortSignal.any([operationSignal, ownerSignal]) : operationSignal;
    let state: ProviderAccountState;
    try {
      refreshSignal.throwIfAborted();
      state = await store.readProviderAsync(this.provider.id, refreshSignal);
      refreshSignal.throwIfAborted();
    } catch (error) {
      return this.failClosed(
        ctx,
        operation,
        runtimeOverride,
        selectedAccount ?? "unknown",
        error,
        undefined,
        "store_unavailable",
      );
    }
    if (selectedAccount === null) {
      this.availableModelIds = undefined;
      try {
        await this.restoreDefault(ctx, operation, refreshSignal, ownerSignal ?? refreshSignal);
        return { status: "inactive", providerId: this.provider.id };
      } catch (error) {
        if (!this.overlay.isCurrent(operation)) {
          return { status: "inactive", providerId: this.provider.id };
        }
        return this.failClosed(
          ctx,
          this.overlay.beginOperation(),
          this.controller.begin(ctx),
          "unknown",
          error,
          undefined,
          "authentication_failed",
        );
      }
    }

    const active = selectedAccount;
    let credential = getOwnCredential(state.accounts, active);
    if (!credential) {
      if (!this.overlay.isCurrent(operation)) {
        return { status: "inactive", providerId: this.provider.id };
      }
      return this.failClosed(
        ctx,
        operation,
        runtimeOverride,
        active,
        new Error(`${this.provider.displayName} account "${active}" is no longer available.`),
        undefined,
        "account_not_found",
      );
    }

    if (credential.type === "oauth" && credential.expires <= now + REFRESH_SKEW_MS) {
      let refreshError: unknown;
      let current = state;
      try {
        current = await store.updateProviderAsync(
          this.provider.id,
          async (latest) => {
            const refreshed = await refreshAccountCredential(latest, active, this.provider, ctx, now, refreshSignal);
            credential = getOwnCredential(refreshed.accounts, active) ?? credential;
            return refreshed;
          },
          refreshSignal,
        );
      } catch (error) {
        refreshError = error;
        credential = getOwnCredential(current.accounts, active) ?? credential;
      }
      if (!getOwnCredential(current.accounts, active)) {
        if (!this.overlay.isCurrent(operation)) {
          return { status: "inactive", providerId: this.provider.id };
        }
        return this.failClosed(
          ctx,
          operation,
          runtimeOverride,
          active,
          new Error(`${this.provider.displayName} account "${active}" is no longer available.`),
          undefined,
          "account_not_found",
        );
      }
      if (refreshError !== undefined) {
        const selection = await this.selectedCredentialMatches(store, active, credential, refreshSignal);
        if (selection.error !== undefined) {
          return this.failClosed(
            ctx,
            operation,
            runtimeOverride,
            active,
            selection.error,
            credential,
            "store_unavailable",
          );
        }
        if (!selection.matches) {
          if (!this.overlay.isCurrent(operation)) {
            return { status: "inactive", providerId: this.provider.id };
          }
          return this.ensureActive(ctx, store, active, now, ownerSignal);
        }
        return this.failClosed(
          ctx,
          operation,
          runtimeOverride,
          active,
          refreshError,
          credential,
          "authentication_failed",
        );
      }
    }

    let auth: ModelAuth;
    let runtimeApiKey: string;
    try {
      if (credential.type === "api_key") {
        if (!this.provider.supportsApiKey) throw new Error(`${this.provider.displayName} does not support API keys.`);
        auth = { apiKey: credential.key };
        runtimeApiKey = credential.key;
      } else {
        auth = await resolveProviderOAuth(this.provider, ctx).toAuth(credential);
        runtimeApiKey = validateModelAuth(auth, this.provider);
      }
    } catch (error) {
      const selection = await this.selectedCredentialMatches(store, active, credential, refreshSignal);
      if (selection.error !== undefined) {
        return this.failClosed(
          ctx,
          operation,
          runtimeOverride,
          active,
          selection.error,
          credential,
          "store_unavailable",
        );
      }
      if (!selection.matches) {
        if (!this.overlay.isCurrent(operation)) {
          return { status: "inactive", providerId: this.provider.id };
        }
        return this.ensureActive(ctx, store, active, now, ownerSignal);
      }
      return this.failClosed(ctx, operation, runtimeOverride, active, error, credential, "authentication_failed");
    }

    const selection = await this.selectedCredentialMatches(store, active, credential, refreshSignal);
    if (selection.error !== undefined) {
      return this.failClosed(ctx, operation, runtimeOverride, active, selection.error, credential, "store_unavailable");
    }
    if (!selection.matches) {
      if (!this.overlay.isCurrent(operation)) {
        return { status: "inactive", providerId: this.provider.id };
      }
      return this.ensureActive(ctx, store, active, now, ownerSignal);
    }

    try {
      refreshSignal.throwIfAborted();
      let availableModelIds = readAvailableModelIds(credential);
      if (
        !this.overlay.apply(
          ctx,
          operation,
          auth,
          availableModelIds,
          this.trackRequest?.(ctx, active, credential, ownerSignal ?? refreshSignal),
        )
      ) {
        return { status: "inactive", providerId: this.provider.id };
      }
      const applied = await this.controller.apply(ctx, runtimeOverride, runtimeApiKey);
      if (applied === "stale") return { status: "inactive", providerId: this.provider.id };
      if (applied === "unavailable") {
        throw new Error(`Pi did not retain the runtime ${this.provider.displayName} credential.`);
      }
      refreshSignal.throwIfAborted();
      const catalogModelIds = await this.refreshModelCatalog(
        ctx,
        refreshSignal,
        `account:${credentialSecret(credential)}`,
      );
      if (catalogModelIds) availableModelIds = catalogModelIds;
      await this.rebindRefreshedModel(ctx, operation);
      if (!this.overlay.isCurrent(operation)) {
        return { status: "inactive", providerId: this.provider.id };
      }
      const refreshedSelection = await this.selectedCredentialMatches(store, active, credential, refreshSignal);
      if (refreshedSelection.error !== undefined) {
        return this.failClosed(
          ctx,
          operation,
          runtimeOverride,
          active,
          refreshedSelection.error,
          credential,
          "store_unavailable",
        );
      }
      if (!refreshedSelection.matches) {
        if (!this.overlay.isCurrent(operation)) {
          return { status: "inactive", providerId: this.provider.id };
        }
        return this.ensureActive(ctx, store, active, now, ownerSignal);
      }
      refreshSignal.throwIfAborted();
      await this.verifyOverlay(ctx, auth, refreshSignal, availableModelIds);
      refreshSignal.throwIfAborted();
      if (auth.apiKey !== undefined) {
        await verifyModelApiKeyAuth(ctx, this.provider, auth.apiKey, refreshSignal, availableModelIds);
        refreshSignal.throwIfAborted();
      }
      if (!this.overlay.isCurrent(operation)) {
        return { status: "inactive", providerId: this.provider.id };
      }
      const credentialClone = credential.type === "api_key" ? { ...credential } : cloneOAuthCredential(credential);
      if (!credentialClone) {
        throw new Error(`${this.provider.displayName} credential could not be cloned safely.`);
      }
      this.availableModelIds = availableModelIds ? new Set(availableModelIds) : undefined;
      this.pendingCredentialOffer = {
        accountName: active,
        credential: credentialClone,
        operation,
        session: ctx.sessionManager,
      };
      return { status: "active", providerId: this.provider.id, accountName: active };
    } catch (error) {
      return this.failClosed(
        ctx,
        operation,
        runtimeOverride,
        active,
        error,
        credential,
        error instanceof EffectiveAuthConflictError ? "effective_auth_conflict" : "activation_failed",
      );
    }
  }

  isModelAvailable(modelId: string): boolean {
    return !this.availableModelIds || this.availableModelIds.has(modelId);
  }

  getAppliedAuthIdentity(ctx: ExtensionContext, result: EnsureActiveProviderAuthResult): string {
    if (result.status === "inactive") return "default";
    if (result.status === "error") return `error:${result.accountName}`;
    const pending = this.pendingCredentialOffer;
    if (
      !pending ||
      pending.session !== ctx.sessionManager ||
      pending.accountName !== result.accountName ||
      !this.overlay.isCurrent(pending.operation)
    ) {
      throw new Error(`${this.provider.displayName} could not identify the credential applied to this session.`);
    }
    return `${pending.accountName}:${credentialSecret(pending.credential)}`;
  }

  publishCredentialOffer(ctx: ExtensionContext, result: EnsureActiveProviderAuthResult, activeIdentity: string): void {
    this.activeCredentialOffer = undefined;
    const pending = this.pendingCredentialOffer;
    this.pendingCredentialOffer = undefined;
    if (result.status !== "active" || !pending) return;
    if (pending.session !== ctx.sessionManager || pending.accountName !== result.accountName) return;
    if (!this.overlay.isCurrent(pending.operation)) return;
    if (activeIdentity !== `${pending.accountName}:${credentialSecret(pending.credential)}`) return;
    if (pending.credential.type !== "oauth") return;
    const credential = cloneOAuthCredential(pending.credential);
    if (!credential) return;
    this.activeCredentialOffer = { credential, session: pending.session };
  }

  offerCredential(data: unknown): void {
    const request = parseCredentialRequest(data);
    const active = this.activeCredentialOffer;
    if (!request || !active) return;
    if (request.session !== active.session || request.provider !== this.provider.id) return;
    const credential = cloneOAuthCredential(active.credential);
    if (!credential) return;
    try {
      request.offer(credential);
    } catch {
      // Credential requests are advisory and must not interrupt runtime authentication.
    }
  }

  private clearCredentialOffer(): void {
    this.pendingCredentialOffer = undefined;
    this.activeCredentialOffer = undefined;
  }

  private beginRefreshOperation(): AbortSignal {
    this.refreshController.abort(new DOMException("Account operation superseded", "AbortError"));
    this.refreshController = new AbortController();
    return this.refreshController.signal;
  }

  private async restoreDefault(
    ctx: ExtensionContext,
    operation: number,
    signal: AbortSignal,
    ownerSignal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.controller.clear(ctx);
    signal.throwIfAborted();
    if (this.catalogAuthIdentity !== undefined) {
      await this.refreshModelCatalog(ctx, signal, "default");
      await this.rebindRefreshedModel(ctx, operation);
    }
    if (!this.overlay.isCurrent(operation)) return;
    this.overlay.remove(ctx, operation);
    const wrap = this.trackRequest?.(ctx, null, undefined, ownerSignal);
    if (wrap) {
      this.overlay.apply(ctx, operation, {}, undefined, wrap);
      const key = await ctx.modelRegistry.getApiKeyForProvider(this.provider.id);
      signal.throwIfAborted();
      if (!key) {
        // Keep Pi's early configured-auth guard traversable so another process can
        // replace an unconfigured built-in selection before the next request.
        // The request boundary rejects this non-secret fail-closed sentinel locally.
        await this.controller.apply(ctx, this.controller.begin(ctx), this.failClosedApiKey);
      }
    }
  }

  private async refreshModelCatalog(
    ctx: ExtensionContext,
    signal: AbortSignal,
    authIdentity: string,
  ): Promise<string[] | undefined> {
    if (!this.provider.refreshModelCatalogAfterAuth) return undefined;
    if (this.catalogAuthIdentity !== authIdentity) {
      const result = await ctx.modelRegistry.refresh({
        allowNetwork: true,
        providers: [this.provider.id],
        signal,
      });
      signal.throwIfAborted();
      const error = result.errors.get(this.provider.id);
      if (error) throw error;
      if (result.aborted) {
        throw new Error(`${this.provider.displayName} model catalog refresh was aborted.`);
      }
      this.catalogAuthIdentity = authIdentity;
    }
    return readProviderModels(ctx, this.provider.id).map((model) => model.id);
  }

  private async rebindRefreshedModel(ctx: ExtensionContext, operation: number): Promise<void> {
    if (!this.provider.refreshModelCatalogAfterAuth || ctx.model?.provider !== this.provider.id) return;
    const refreshed = ctx.modelRegistry.find(this.provider.id, ctx.model.id);
    if (!refreshed) {
      throw new Error(`${this.provider.displayName} model ${ctx.model.id} is unavailable after catalog refresh.`);
    }
    if (sameModelDefinition(ctx.model, refreshed)) return;
    if (!this.overlay.isCurrent(operation)) return;
    // ExtensionContext has no session-scoped setModel action. Replace the live definition held by
    // this context instead of using the factory-bound action, which can target another runner.
    replaceModelDefinition(ctx.model, refreshed);
  }

  async forceFailClosed(
    ctx: ExtensionContext,
    accountName: string,
    error: unknown,
    credential?: StoredCredential,
  ): Promise<EnsureActiveProviderAuthResult> {
    return this.failClosed(
      ctx,
      this.overlay.beginOperation(),
      this.controller.begin(ctx),
      accountName,
      error,
      credential,
    );
  }

  invalidate(ctx: ExtensionContext, resetCatalogIdentity = true): void {
    this.clearCredentialOffer();
    if (resetCatalogIdentity) this.catalogAuthIdentity = undefined;
    this.overlay.beginOperation();
    this.controller.invalidate(ctx);
    this.refreshController.abort(new DOMException("Account refresh invalidated", "AbortError"));
    this.refreshController = new AbortController();
  }

  async clear(ctx: ExtensionContext, restoreDefaultCatalog = false): Promise<void> {
    this.clearCredentialOffer();
    const operation = this.overlay.beginOperation();
    this.availableModelIds = undefined;
    await this.controller.clear(ctx);
    try {
      if (restoreDefaultCatalog && this.catalogAuthIdentity !== undefined) {
        await this.refreshModelCatalog(
          ctx,
          AbortSignal.any([this.refreshController.signal, AbortSignal.timeout(SHUTDOWN_CATALOG_REFRESH_TIMEOUT_MS)]),
          "default",
        );
      }
    } finally {
      this.overlay.remove(ctx, operation);
      if (!restoreDefaultCatalog) this.catalogAuthIdentity = undefined;
    }
  }

  private async failClosed(
    ctx: ExtensionContext,
    operation: number,
    runtimeOverride: RuntimeOverrideSnapshot | undefined,
    accountName: string,
    error: unknown,
    credential?: StoredCredential,
    code: AccountActivationErrorCode = "activation_failed",
  ): Promise<EnsureActiveProviderAuthResult> {
    if (!this.overlay.isCurrent(operation)) {
      return { status: "inactive", providerId: this.provider.id };
    }
    this.clearCredentialOffer();
    let suffix = "";
    try {
      this.overlay.apply(ctx, operation, {}, credential ? safelyReadAvailableModelIds(credential) : undefined);
    } catch {
      suffix = " Pi could not apply the fail-closed provider overlay.";
    }
    try {
      const applied = await this.controller.apply(ctx, runtimeOverride, this.failClosedApiKey);
      if (applied === "stale") return { status: "inactive", providerId: this.provider.id };
      if (applied === "unavailable") suffix += " Pi did not accept the fail-closed credential.";
    } catch {
      suffix += " Pi could not apply the fail-closed credential; provider turns will be aborted.";
    }
    const availableModelIds = credential ? safelyReadAvailableModelIds(credential) : undefined;
    this.availableModelIds = availableModelIds ? new Set(availableModelIds) : undefined;
    return {
      status: "error",
      providerId: this.provider.id,
      accountName,
      message: `${credential ? redactCredentialError(error, credential) : redactTokenText(errorMessage(error))}${suffix}`,
      code,
    };
  }

  private async selectedCredentialMatches(
    store: RuntimeAccountStore,
    accountName: string,
    expected: StoredCredential,
    signal?: AbortSignal,
  ): Promise<{ matches: boolean; error?: unknown }> {
    try {
      const latest = await store.readProviderAsync(this.provider.id, signal);
      const current = getOwnCredential(latest.accounts, accountName);
      return {
        matches: current !== undefined && JSON.stringify(current) === JSON.stringify(expected),
      };
    } catch (error) {
      return { matches: false, error };
    }
  }

  private async verifyOverlay(
    ctx: ExtensionContext,
    auth: ModelAuth,
    signal: AbortSignal,
    availableModelIds?: readonly string[],
  ): Promise<void> {
    const registered =
      ctx.modelRegistry.getRegisteredNativeProvider(this.provider.id) ??
      ctx.modelRegistry.getRegisteredProviderConfig(this.provider.id);
    if (auth.baseUrl && registered?.baseUrl !== auth.baseUrl) {
      throw new Error(`Pi did not retain the runtime ${this.provider.displayName} endpoint.`);
    }
    if (auth.headers) {
      for (const [name, value] of Object.entries(auth.headers)) {
        if (value !== null && readHeader(registered?.headers, name) !== value) {
          throw new Error(`Pi did not retain the runtime ${this.provider.displayName} headers.`);
        }
        if (value === null && hasHeader(registered?.headers, name)) {
          throw new Error(`Pi did not remove the runtime ${this.provider.displayName} header.`);
        }
      }
    }
    const allowed = availableModelIds ? new Set(availableModelIds) : undefined;
    for (const candidate of readProviderModels(ctx, this.provider.id)) {
      if (allowed && !allowed.has(candidate.id)) continue;
      signal.throwIfAborted();
      const model = findProviderModel(ctx, this.provider.id, candidate.id);
      if (!model) continue;
      if (auth.baseUrl && model.baseUrl !== auth.baseUrl) {
        throw new EffectiveAuthConflictError(`Pi did not apply the runtime ${this.provider.displayName} endpoint.`);
      }
      if (!auth.headers) continue;
      const resolved = await getApiKeyAndHeaders(ctx, model);
      signal.throwIfAborted();
      if (resolved?.ok === false) {
        throw new Error(`Pi could not resolve the runtime ${this.provider.displayName} headers.`);
      }
      for (const [name, value] of Object.entries(auth.headers)) {
        const matches = Object.entries(resolved?.headers ?? {}).filter(
          ([header]) => header.toLowerCase() === name.toLowerCase(),
        );
        if (value !== null && (matches.length !== 1 || matches[0]?.[1] !== value)) {
          throw new EffectiveAuthConflictError(`Pi did not apply the runtime ${this.provider.displayName} headers.`);
        }
        if (value === null && matches.length > 0) {
          throw new EffectiveAuthConflictError(`Pi did not remove the runtime ${this.provider.displayName} header.`);
        }
      }
    }
  }
}

class RuntimeProviderOverlay {
  private generation = 0;
  private owned = false;
  private previous: RuntimeProviderRegistration | undefined;
  private applied: RuntimeProviderRegistration | undefined;
  private baseModels: NonNullable<RuntimeProviderConfig["models"]> | undefined;
  private baseStream: RuntimeProviderConfig["streamSimple"];

  constructor(
    private readonly provider: AccountProviderAdapter,
    private readonly fallbackApiKey: string,
  ) {}

  beginOperation(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  apply(
    ctx: ExtensionContext,
    generation: number,
    auth: ModelAuth,
    availableModelIds?: readonly string[],
    wrapStream?: StreamWrapper,
  ): boolean {
    if (generation !== this.generation) return false;
    const needsOverlay =
      wrapStream !== undefined ||
      this.provider.requiresApiKeyBridge ||
      auth.baseUrl !== undefined ||
      (auth.headers !== undefined && Object.keys(auth.headers).length > 0) ||
      availableModelIds !== undefined;
    if (!needsOverlay) {
      if (this.owned) this.remove(ctx, generation);
      return true;
    }
    const current = readProviderRegistration(ctx, this.provider.id);
    if (this.owned && !sameProviderRegistration(current, this.applied)) {
      this.reset();
      throw new Error(
        `${this.provider.displayName} provider configuration changed while pi-accounts owned its auth overlay.`,
      );
    }
    if (!this.owned) {
      this.previous = current;
      this.baseModels = [
        ...readProviderModels(ctx, this.provider.id),
        ...ctx.modelRegistry.getModelsOfType("image", this.provider.id),
        ...ctx.modelRegistry.getModelsOfType("classifier", this.provider.id),
      ];
      const provider = wrapStream ? ctx.modelRegistry.getProvider(this.provider.id) : undefined;
      this.baseStream =
        (current?.kind === "config" ? current.config.streamSimple : undefined) ?? provider?.streamSimple.bind(provider);
    }

    let next: RuntimeProviderRegistration;
    if (this.previous?.kind === "native") {
      next = {
        kind: "native",
        provider: this.buildNativeProvider(this.previous.provider, auth, availableModelIds, wrapStream),
      };
    } else {
      const config = this.buildConfig(auth, availableModelIds);
      if (wrapStream) {
        if (!this.baseStream) {
          const provider = ctx.modelRegistry.getProvider(this.provider.id);
          this.baseStream = provider?.streamSimple.bind(provider);
        }
        if (!this.baseStream) throw new Error("OpenAI inference stream is unavailable for request synchronization.");
        config.api ??= "openai-responses";
        config.streamSimple = wrapStream(this.baseStream);
      }
      next = { kind: "config", config };
    }
    replaceProviderRegistration(ctx, this.provider.id, current, next);
    this.owned = true;
    this.applied = next;
    return true;
  }

  remove(ctx: ExtensionContext, generation: number): void {
    if (generation !== this.generation || !this.owned) return;
    const current = readProviderRegistration(ctx, this.provider.id);
    if (!sameProviderRegistration(current, this.applied)) {
      this.reset();
      return;
    }
    replaceProviderRegistration(ctx, this.provider.id, current, this.previous);
    this.reset();
  }

  private buildConfig(auth: ModelAuth, availableModelIds?: readonly string[]): RuntimeProviderConfig {
    const previous = this.previous?.kind === "config" ? this.previous.config : undefined;
    const next: RuntimeProviderConfig = { ...(previous ?? {}) };
    if (this.provider.requiresApiKeyBridge) next.apiKey = this.fallbackApiKey;
    if (auth.baseUrl) next.baseUrl = auth.baseUrl;
    if (auth.headers) next.headers = mergeConfigHeaders(previous?.headers, auth.headers);
    if (availableModelIds) {
      const allowed = new Set(availableModelIds);
      next.models = (this.baseModels ?? [])
        .filter((model) => model.type === "image" || model.type === "classifier" || allowed.has(model.id))
        .map((model) => (auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model));
    }
    return next;
  }

  private buildNativeProvider(
    native: Provider,
    auth: ModelAuth,
    availableModelIds?: readonly string[],
    wrapStream?: StreamWrapper,
  ): Provider {
    const allowed = availableModelIds ? new Set(availableModelIds) : undefined;
    const project = <T extends AnyModel>(models: readonly T[]): T[] =>
      models
        .filter((model) => !allowed || model.type === "image" || model.type === "classifier" || allowed.has(model.id))
        .map((model) => (auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model));
    const applyAuth = (current: ModelAuth): ModelAuth => ({
      ...current,
      ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
      ...(auth.headers ? { headers: mergeConfigHeaders(current.headers, auth.headers) } : {}),
    });
    const apiKey = native.auth.apiKey ?? envApiKeyAuth(this.provider.displayName, []);
    const oauth = native.auth.oauth;
    const streamSimple = native.streamSimple.bind(native);
    return {
      ...native,
      id: native.id,
      name: native.name,
      baseUrl: auth.baseUrl ?? native.baseUrl,
      headers: auth.headers ? mergeConfigHeaders(native.headers, auth.headers) : native.headers,
      auth: {
        ...native.auth,
        apiKey: {
          ...apiKey,
          login: apiKey.login?.bind(apiKey),
          check: apiKey.check?.bind(apiKey),
          resolve: async (input) => {
            const result = await apiKey.resolve(input);
            return result ? { ...result, auth: applyAuth(result.auth) } : undefined;
          },
        },
        ...(oauth
          ? {
              oauth: {
                ...oauth,
                login: oauth.login.bind(oauth),
                refresh: oauth.refresh.bind(oauth),
                toAuth: async (credential) => applyAuth(await oauth.toAuth(credential)),
              },
            }
          : {}),
      },
      getModels: () => project(native.getModels()),
      getAllModels: () => project(native.getAllModels?.() ?? native.getModels()),
      refreshModels: native.refreshModels?.bind(native),
      filterModels: native.filterModels?.bind(native),
      filterAllModels: native.filterAllModels?.bind(native),
      stream: native.stream.bind(native),
      streamSimple: wrapStream ? wrapStream(streamSimple) : streamSimple,
      fetchDeferred: native.fetchDeferred?.bind(native),
      cancelDeferred: native.cancelDeferred?.bind(native),
      generateImages: native.generateImages?.bind(native),
      classify: native.classify?.bind(native),
    };
  }

  private reset(): void {
    this.owned = false;
    this.previous = undefined;
    this.applied = undefined;
    this.baseModels = undefined;
    this.baseStream = undefined;
  }
}

class RuntimeApiKeyController {
  private readonly states = new WeakMap<object, RuntimeOverrideState>();

  constructor(private readonly providerId: string) {}

  begin(ctx: ExtensionContext): RuntimeOverrideSnapshot | undefined {
    const target = getRuntimeAuthStorage(ctx);
    if (!target) return undefined;
    const state = this.getState(target);
    state.generation += 1;
    return { target, state, generation: state.generation };
  }

  async apply(
    ctx: ExtensionContext,
    snapshot: RuntimeOverrideSnapshot | undefined,
    apiKey: string,
  ): Promise<"applied" | "stale" | "unavailable"> {
    if (!(await this.set(snapshot, apiKey))) return "stale";
    const matches = await this.matches(ctx, apiKey);
    if (matches !== false) return "applied";
    if (!(await this.set(snapshot, apiKey, true))) return "stale";
    return (await this.matches(ctx, apiKey)) === false ? "unavailable" : "applied";
  }

  invalidate(ctx: ExtensionContext): void {
    const target = getRuntimeAuthStorage(ctx);
    const state = target ? this.states.get(target) : undefined;
    if (state) state.generation += 1;
  }

  async clear(ctx: ExtensionContext): Promise<void> {
    const target = getRuntimeAuthStorage(ctx);
    if (!target) return;
    const state = this.states.get(target);
    if (!state) return;
    state.generation += 1;
    await enqueueMutation(state, async () => {
      if (!state.mayHaveOverride) return;
      await target.removeRuntimeApiKey(this.providerId);
      state.appliedApiKey = undefined;
      state.mayHaveOverride = false;
    });
  }

  private async matches(ctx: ExtensionContext, expected: string): Promise<boolean | undefined> {
    const registry = ctx.modelRegistry as unknown as {
      getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
    };
    if (typeof registry.getApiKeyForProvider !== "function") return undefined;
    try {
      return (await registry.getApiKeyForProvider(this.providerId)) === expected;
    } catch {
      return false;
    }
  }

  private async set(snapshot: RuntimeOverrideSnapshot | undefined, apiKey: string, force = false): Promise<boolean> {
    if (!snapshot) throw new Error("This Pi version does not expose runtime provider authentication.");
    const { generation, state, target } = snapshot;
    return enqueueMutation(state, async () => {
      if (state.generation !== generation) return false;
      if (!force && state.appliedApiKey === apiKey) return true;
      state.appliedApiKey = undefined;
      state.mayHaveOverride = true;
      await target.setRuntimeApiKey(this.providerId, apiKey);
      state.appliedApiKey = apiKey;
      return state.generation === generation;
    });
  }

  private getState(target: object): RuntimeOverrideState {
    let state = this.states.get(target);
    if (!state) {
      state = { generation: 0, mayHaveOverride: false, operationTail: Promise.resolve() };
      this.states.set(target, state);
    }
    return state;
  }
}

function sameModelDefinition(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function replaceModelDefinition(target: object, source: object): void {
  const writable = target as Record<string, unknown>;
  for (const key of Object.keys(writable)) {
    if (!Object.hasOwn(source, key)) delete writable[key];
  }
  Object.assign(writable, source);
  if (!sameModelDefinition(writable, source)) {
    throw new Error("Pi did not retain the refreshed model definition.");
  }
}

function readProviderModels(ctx: ExtensionContext, providerId: string) {
  return ctx.modelRegistry.getAll().filter((model) => model.provider === providerId);
}

function readHeader(
  headers: ProviderHeaders | Record<string, string> | undefined,
  name: string,
): string | null | undefined {
  const expected = name.toLowerCase();
  for (const [candidate, value] of Object.entries(headers ?? {})) {
    if (candidate.toLowerCase() === expected) return value;
  }
  return undefined;
}

function hasHeader(headers: ProviderHeaders | Record<string, string> | undefined, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers ?? {}).some((candidate) => candidate.toLowerCase() === expected);
}

function mergeConfigHeaders(previous: ProviderHeaders | undefined, headers: ProviderHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(previous ?? {})) {
    if (value !== null) result[name] = value;
  }
  for (const [name, value] of Object.entries(headers)) {
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    }
    if (value !== null) result[name] = value;
  }
  return result;
}

function validateModelAuth(auth: unknown, provider: AccountProviderAdapter): string {
  const providerName = provider.displayName;
  if (!isRecord(auth)) throw new Error(`${providerName} OAuth returned invalid request auth.`);
  if (auth.baseUrl !== undefined) {
    if (typeof auth.baseUrl !== "string") {
      throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(auth.baseUrl);
    } catch {
      throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new Error(`${providerName} OAuth returned an unsafe endpoint.`);
    }
  }
  if (auth.headers !== undefined) {
    if (!isRecord(auth.headers)) {
      throw new Error(`${providerName} OAuth returned invalid headers.`);
    }
    for (const [name, value] of Object.entries(auth.headers)) {
      if (!name || /[\r\n]/.test(name) || (value !== null && typeof value !== "string")) {
        throw new Error(`${providerName} OAuth returned invalid headers.`);
      }
      if (typeof value === "string" && /[\r\n]/.test(value)) {
        throw new Error(`${providerName} OAuth returned invalid headers.`);
      }
    }
  }
  if (provider.runtimeAuthMode === "api-key") {
    if (typeof auth.apiKey !== "string" || !auth.apiKey) {
      throw new Error(`${providerName} OAuth returned no API key.`);
    }
    return auth.apiKey;
  }
  if (auth.apiKey !== undefined) {
    throw new Error(`${providerName} OAuth returned unexpected API-key authentication.`);
  }
  const authorizationHeaders = isRecord(auth.headers)
    ? Object.entries(auth.headers).filter(([name]) => name.toLowerCase() === "authorization")
    : [];
  if (
    authorizationHeaders.length !== 1 ||
    typeof authorizationHeaders[0]?.[1] !== "string" ||
    !/^Bearer\s+\S+$/u.test(authorizationHeaders[0][1])
  ) {
    throw new Error(`${providerName} OAuth returned no valid Bearer authorization header.`);
  }
  return RUNTIME_HEADER_AUTH_SELECTOR;
}

function readAvailableModelIds(credential: StoredCredential): string[] | undefined {
  if (credential.type === "api_key") return undefined;
  if (!Object.hasOwn(credential, "availableModelIds")) return undefined;
  const value = credential.availableModelIds;
  if (
    !Array.isArray(value) ||
    value.length > 1_000 ||
    !value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
  ) {
    throw new Error("OAuth credential has invalid availableModelIds metadata.");
  }
  return [...new Set(value)];
}

function safelyReadAvailableModelIds(credential: StoredCredential): string[] | undefined {
  try {
    return readAvailableModelIds(credential);
  } catch {
    return undefined;
  }
}

function findProviderModel(
  ctx: ExtensionContext,
  providerId: string,
  modelId: string,
): { provider: string; id: string; baseUrl?: string } | undefined {
  const registry = ctx.modelRegistry as unknown as {
    find?: (provider: string, id: string) => { provider: string; id: string; baseUrl?: string } | undefined;
  };
  return typeof registry.find === "function" ? registry.find(providerId, modelId) : undefined;
}

async function getApiKeyAndHeaders(
  ctx: ExtensionContext,
  model: { provider: string; id: string; baseUrl?: string },
): Promise<{ ok: true; apiKey?: string; headers?: ProviderHeaders } | { ok: false; error: string } | undefined> {
  const registry = ctx.modelRegistry as unknown as {
    getApiKeyAndHeaders?: (
      candidate: unknown,
    ) => Promise<{ ok: true; apiKey?: string; headers?: ProviderHeaders } | { ok: false; error: string }>;
  };
  return typeof registry.getApiKeyAndHeaders === "function" ? registry.getApiKeyAndHeaders(model) : undefined;
}

function defineOwn(
  accounts: Record<string, StoredCredential>,
  name: string,
  credential: StoredCredential,
): Record<string, StoredCredential> {
  const next = Object.assign(Object.create(null), accounts) as Record<string, StoredCredential>;
  Object.defineProperty(next, name, {
    configurable: true,
    enumerable: true,
    value: credential,
    writable: true,
  });
  return next;
}

function getOwnCredential(accounts: Record<string, StoredCredential>, name: string): StoredCredential | undefined {
  return Object.hasOwn(accounts, name) ? accounts[name] : undefined;
}

function readProviderRegistration(ctx: ExtensionContext, providerId: string): RuntimeProviderRegistration | undefined {
  const provider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
  if (provider) return { kind: "native", provider };
  const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
  return config ? { kind: "config", config } : undefined;
}

function replaceProviderRegistration(
  ctx: ExtensionContext,
  providerId: string,
  previous: RuntimeProviderRegistration | undefined,
  next: RuntimeProviderRegistration | undefined,
): void {
  const register = (registration: RuntimeProviderRegistration | undefined) => {
    if (registration?.kind === "native") ctx.modelRegistry.registerProvider(registration.provider);
    else if (registration?.kind === "config") ctx.modelRegistry.registerProvider(providerId, registration.config);
  };
  ctx.modelRegistry.unregisterProvider(providerId);
  try {
    register(next);
  } catch (error) {
    ctx.modelRegistry.unregisterProvider(providerId);
    register(previous);
    throw error;
  }
}

function sameProviderRegistration(
  left: RuntimeProviderRegistration | undefined,
  right: RuntimeProviderRegistration | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.kind === "native") return right.kind === "native" && left.provider === right.provider;
  return right.kind === "config" && shallowConfigEqual(left.config, right.config);
}

function shallowConfigEqual(
  left: RuntimeProviderConfig | undefined,
  right: RuntimeProviderConfig | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return !left && !right;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (
      !Object.is((left as unknown as Record<string, unknown>)[key], (right as unknown as Record<string, unknown>)[key])
    )
      return false;
  }
  return true;
}

function enqueueMutation<T>(state: RuntimeOverrideState, mutate: () => Promise<T>): Promise<T> {
  const operation = state.operationTail.then(mutate);
  state.operationTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function getRuntimeAuthStorage(ctx: ExtensionContext): (RuntimeAuthStorage & object) | undefined {
  const registry = ctx.modelRegistry as unknown as { authStorage?: unknown; runtime?: unknown };
  for (const candidate of [registry, registry.runtime, registry.authStorage]) {
    if (isRuntimeAuthStorage(candidate)) return candidate;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeAuthStorage(value: unknown): value is RuntimeAuthStorage & object {
  return (
    !!value &&
    typeof value === "object" &&
    "setRuntimeApiKey" in value &&
    typeof value.setRuntimeApiKey === "function" &&
    "removeRuntimeApiKey" in value &&
    typeof value.removeRuntimeApiKey === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function credentialSecret(credential: StoredCredential): string {
  return credential.type === "api_key" ? credential.key : credential.access;
}

function redactCredentialError(error: unknown, credential: StoredCredential): string {
  return redactTokenText(
    error instanceof Error ? error.message : String(error),
    credential.type === "api_key" ? [credential.key] : [credential.access, credential.refresh],
  );
}

export function redactTokenText(text: string, exactSecrets: readonly string[] = []): string {
  const secrets = [...new Set(exactSecrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const exact = secrets.length ? new RegExp(secrets.map((secret) => escapeRegExp(secret)).join("|"), "g") : undefined;
  return (exact ? text.replace(exact, "<redacted>") : text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/"(access|refresh|access_token|refresh_token|token)"\s*:\s*"[^"]+"/gi, '"$1":"<redacted>"')
    .replace(/\b(access|refresh)[_-][A-Za-z0-9._~+/=-]+/gi, "$1-<redacted>");
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
