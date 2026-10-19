import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AccountActivationOutcome, type ActivateAccount, createAccountActivation } from "./account-activation.js";
import {
  type PersistSelection,
  type ProviderSessionState,
  SessionSelectionOwner,
  type SyncProvider,
} from "./account-session.js";
import {
  AccountStore,
  defineOwn,
  defineOwnMap,
  getOwnCredential,
  normalizeApiKeyCredential,
  normalizeStoredCredential,
  parseAccountName,
  type StoredCredential,
} from "./account-store.js";
import { registerAccountsProtocol } from "./accounts-protocol.js";
import {
  type AccountProviderAdapter,
  type AccountProviderId,
  createBuiltinProviderAdapters,
  loginWithOAuthUI,
  SUPPORTED_PROVIDER_IDS,
} from "./oauth.js";
import {
  parseCredentialReadinessRequest,
  parseCredentialRequest,
  registerOAuthCredentialReadiness,
  registerOAuthCredentialSource,
} from "./oauth-credential-source.js";
import { OpenAIRequests } from "./openai-requests.js";
import type { probeAccount } from "./quota-probe.js";
import { QuotaRecovery } from "./quota-recovery.js";
import {
  type EnsureActiveProviderAuthResult,
  RUNTIME_FAIL_CLOSED_API_KEY,
  RuntimeAuthCoordinator,
  redactTokenText,
} from "./runtime-auth.js";
import {
  ACCOUNT_SELECTION_ENTRY_TYPE,
  cloneAccountSelections,
  createAccountSelectionEntryData,
  type ProviderAccountSelections,
  restoreAccountSelections,
  setAccountSelection,
} from "./session-selection.js";
import { OpenAISelection, readSharedSelection } from "./shared-selection.js";
import type { AccountStorageBackend } from "./storage.js";

export {
  ACCOUNTS_FILE,
  AccountStore,
  type AccountsData,
  InMemoryAccountStorageBackend,
  type ProviderAccountsData,
  parseAccountName,
  parseAccountsData,
  type StoredApiKeyCredential,
  type StoredCredential,
  type StoredOAuthCredential,
} from "./account-store.js";

export const ACCOUNTS_STATUS_KEY = "accounts";
export const FAIL_CLOSED_API_KEY = RUNTIME_FAIL_CLOSED_API_KEY;
export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";

export type AccountsDependencies = {
  store?: AccountStore;
  recoveryBackend?: AccountStorageBackend;
  probe?: typeof probeAccount;
  providers?: readonly AccountProviderAdapter[];
  closeCodexWebSockets?: (sessionId?: string) => unknown | Promise<unknown>;
};

export default function accountsExtension(pi: ExtensionAPI, dependencies: AccountsDependencies = {}): void {
  const store = dependencies.store ?? new AccountStore();
  const sharedSelection = new OpenAISelection(store);
  const recovery = new QuotaRecovery(store, sharedSelection, dependencies.recoveryBackend);
  let openaiRequests: OpenAIRequests | undefined;
  const providers = [
    ...(dependencies.providers ??
      createBuiltinProviderAdapters({ closeCodexWebSockets: dependencies.closeCodexWebSockets })),
  ];
  validateProviderSet(providers, dependencies.providers === undefined);
  const adapters = new Map(providers.map((provider) => [provider.id, provider]));
  const sessionProviders = providers.filter((provider) => provider.id !== "openai");
  const sessionOwners = new WeakMap<ExtensionContext["sessionManager"], SessionSelectionOwner>();
  registerOAuthCredentialSource(pi, [
    {
      offerCredential(data) {
        const request = parseCredentialRequest(data);
        if (!request) return;
        const owner = sessionOwners.get(request.session as ExtensionContext["sessionManager"]);
        const providerId = toProviderId(request.provider);
        if (!owner || !providerId) return;
        owner.providers.get(providerId)?.coordinator.offerCredential(data);
      },
    },
  ]);

  const isOwnerCurrent = (owner: SessionSelectionOwner): boolean =>
    sessionOwners.get(owner.sessionManager) === owner && !owner.signal.aborted;

  const initializeOwner = async (owner: SessionSelectionOwner, ctx: ExtensionContext): Promise<void> => {
    if (sessionProviders.length === 0) return;
    const restored = restoreAccountSelections(ctx.sessionManager.getEntries(), owner.sessionId);
    if (restored.status === "invalid") {
      owner.error = restored.message;
      ctx.ui.notify(
        owner.environmentAccount === undefined
          ? restored.message
          : "The saved session selection is invalid, but PI_ACCOUNT remains active. Unset it and restart Pi to recover via /accounts.",
        owner.environmentAccount === undefined ? "error" : "warning",
      );
      return;
    }
    let selections =
      restored.status === "loaded"
        ? restored.selections
        : cloneAccountSelections(Object.create(null) as ProviderAccountSelections);
    const missingProviders = sessionProviders.filter((provider) => !Object.hasOwn(selections, provider.id));
    if (restored.status === "loaded" && missingProviders.length === 0) {
      owner.selections = selections;
      return;
    }
    try {
      const data = await store.readAsync(owner.signal);
      if (!isOwnerCurrent(owner)) return;
      for (const provider of missingProviders) {
        selections = setAccountSelection(selections, provider.id, data.providers[provider.id]?.active ?? null);
      }
      owner.sessionManager.appendCustomEntry(
        ACCOUNT_SELECTION_ENTRY_TYPE,
        createAccountSelectionEntryData(owner.sessionId, selections),
      );
      if (!isOwnerCurrent(owner)) return;
      owner.selections = selections;
    } catch {
      if (!isOwnerCurrent(owner)) return;
      owner.error =
        "Could not persist this Pi session's account selection. Choose an account or default from /accounts to retry.";
      ctx.ui.notify(
        owner.environmentAccount === undefined
          ? owner.error
          : "Could not persist the saved session selection, but PI_ACCOUNT remains active. Unset it and restart Pi to retry via /accounts.",
        owner.environmentAccount === undefined ? "error" : "warning",
      );
    }
  };

  const startSessionOwner = (ctx: ExtensionContext): SessionSelectionOwner => {
    const previous = sessionOwners.get(ctx.sessionManager);
    if (previous) {
      openaiRequests?.cancel(previous.context);
      void previous.dispose(ctx);
    }
    const environment = readEnvironmentAccount();
    const owner = new SessionSelectionOwner(
      ctx,
      providers.map(
        (provider) =>
          new RuntimeAuthCoordinator(
            provider,
            RUNTIME_FAIL_CLOSED_API_KEY,
            provider.id === "openai"
              ? (ctx, name, credential, signal) => openaiRequests?.wrap(ctx, name, credential, signal)
              : undefined,
          ),
      ),
      environment.account,
      environment.error,
    );
    sessionOwners.set(ctx.sessionManager, owner);
    if (owner.environmentError) ctx.ui.notify(owner.environmentError, "error");
    owner.ready = initializeOwner(owner, ctx);
    return owner;
  };

  const ensureSessionOwner = async (ctx: ExtensionContext): Promise<SessionSelectionOwner> => {
    let owner = sessionOwners.get(ctx.sessionManager);
    if (!owner || owner.sessionId !== ctx.sessionManager.getSessionId()) {
      owner = startSessionOwner(ctx);
    }
    await owner.ready;
    return owner;
  };

  const persistSelection: PersistSelection = async (owner, providerId, accountName, isCurrent) => {
    if (!isOwnerCurrent(owner) || !isCurrent() || owner.environmentAccount !== undefined || owner.environmentError) {
      return false;
    }
    const provider = owner.providers.get(providerId);
    if (!provider) return false;
    if (providerId === "openai") {
      const published = await sharedSelection.select(
        accountName,
        owner.signal,
        () => isOwnerCurrent(owner) && isCurrent(),
      );
      if (!published || !isOwnerCurrent(owner) || !isCurrent()) return false;
      openaiRequests?.cancel(owner.context, true);
      provider.selectionRevision++;
      return true;
    }
    let selections = owner.error
      ? sessionProviders.reduce<ProviderAccountSelections>(
          (current, provider) => setAccountSelection(current, provider.id, null),
          cloneAccountSelections(Object.create(null) as ProviderAccountSelections),
        )
      : owner.selections;
    selections = setAccountSelection(selections, providerId, accountName);
    owner.sessionManager.appendCustomEntry(
      ACCOUNT_SELECTION_ENTRY_TYPE,
      createAccountSelectionEntryData(owner.sessionId, selections),
    );
    if (!isOwnerCurrent(owner) || !isCurrent()) return false;
    owner.selections = selections;
    provider.selectionRevision++;
    owner.error = undefined;
    return true;
  };

  const staleResult = (providerId: AccountProviderId): EnsureActiveProviderAuthResult => ({
    status: "inactive",
    providerId,
  });

  const syncProvider: SyncProvider = (providerId, ctx, owner, ownerSignal, model = ctx.model) => {
    const provider = owner.providers.get(providerId);
    if (!provider || !isOwnerCurrent(owner)) return Promise.resolve(staleResult(providerId));
    const adapter = requireAdapter(adapters, providerId);
    const { coordinator } = provider;
    let task!: Promise<EnsureActiveProviderAuthResult>;
    const current = () => isOwnerCurrent(owner) && provider.syncTask === task;
    const replacement = () =>
      provider.syncTask && provider.syncTask !== task ? provider.syncTask : staleResult(providerId);
    task = (async () => {
      const signal = ownerSignal ? AbortSignal.any([owner.signal, ownerSignal]) : owner.signal;
      let selectionError = owner.environmentError ?? (owner.environmentAccount === undefined ? owner.error : undefined);
      let selectedAccount = owner.environmentAccount ?? owner.selections[providerId] ?? null;
      let sharedRevision: string | undefined;
      if (providerId === "openai") {
        try {
          if (hasEnvironmentSelection(owner))
            throw new Error("Shared OpenAI account selection requires PI_ACCOUNT to be unset.");
          const shared = await sharedSelection.ensure(signal);
          if (!current()) return replacement();
          selectedAccount = shared.account;
          sharedRevision = shared.revision;
          selectionError = undefined;
        } catch (error) {
          selectionError = errorMessage(error);
        }
      }
      let result = selectionError
        ? await coordinator.forceFailClosed(ctx, "unknown", new Error(selectionError))
        : await coordinator.ensureActive(ctx, store, selectedAccount, Date.now(), signal);
      if (providerId === "openai" && sharedRevision && result.status !== "error" && current()) {
        const latestShared = readSharedSelection(await store.readProviderAsync("openai", signal));
        if (latestShared?.revision !== sharedRevision) return syncProvider(providerId, ctx, owner, ownerSignal, model);
      }
      let identity: string | undefined;
      if (!current()) return replacement();
      try {
        identity = coordinator.getAppliedAuthIdentity(ctx, result);
        const previousIdentity = provider.appliedIdentity;
        if (previousIdentity !== identity && !(previousIdentity === undefined && identity === "default")) {
          await adapter.invalidateConnections?.(owner.sessionId);
          if (!current()) return replacement();
        }
        provider.appliedIdentity = identity;
      } catch (error) {
        if (!current()) return replacement();
        const credential = await selectedCredential(store, providerId, result, signal);
        if (!current()) return replacement();
        result = await coordinator.forceFailClosed(
          ctx,
          result.status === "inactive" ? "unknown" : result.accountName,
          error,
          credential,
        );
      }
      if (!current()) return replacement();
      coordinator.publishCredentialOffer(ctx, result, identity ?? "");
      provider.result = result;
      updateStatus(ctx, owner.providers, model, hasEnvironmentSelection(owner));
      return result;
    })();
    provider.syncTask = task;
    provider.pendingSync = task;
    const clearPending = () => {
      if (provider.pendingSync === task) provider.pendingSync = undefined;
    };
    void task.then(clearPending, clearPending);
    return task;
  };

  const startupProvider = (
    providerId: AccountProviderId,
    ctx: ExtensionContext,
    owner: SessionSelectionOwner,
  ): Promise<EnsureActiveProviderAuthResult> => {
    const provider = owner.providers.get(providerId);
    if (!provider) return Promise.resolve(staleResult(providerId));
    if (provider.started) return Promise.resolve(provider.result ?? staleResult(providerId));
    if (provider.startupTask) return provider.startupTask;
    const task = syncProvider(providerId, ctx, owner).finally(() => {
      if (!isOwnerCurrent(owner) || provider.startupTask !== task) return;
      provider.startupTask = undefined;
      provider.started = true;
    });
    provider.startupTask = task;
    return task;
  };

  const syncAll = async (ctx: ExtensionContext, owner: SessionSelectionOwner): Promise<void> => {
    for (const provider of providers) {
      if (!isOwnerCurrent(owner)) return;
      const result = await startupProvider(provider.id, ctx, owner);
      if (!isOwnerCurrent(owner)) return;
      if (result.status === "error" && (!hasEnvironmentSelection(owner) || ctx.model?.provider === provider.id)) {
        ctx.ui.notify(
          hasEnvironmentSelection(owner)
            ? `${provider.displayName} account selected by PI_ACCOUNT failed closed. Check that the account exists and its authentication is valid.`
            : `${provider.displayName} account "${result.accountName}" failed closed: ${result.message}`,
          "error",
        );
      }
    }
    if (isOwnerCurrent(owner)) updateStatus(ctx, owner.providers, ctx.model, hasEnvironmentSelection(owner));
  };

  const waitForCurrentProvider = async (providerId: AccountProviderId, owner: SessionSelectionOwner): Promise<void> => {
    await owner.ready;
    if (!isOwnerCurrent(owner)) return;
    const provider = owner.providers.get(providerId);
    if (!provider) return;
    let pending =
      provider.pendingSync ??
      (provider.started
        ? syncProvider(providerId, owner.context, owner)
        : startupProvider(providerId, owner.context, owner));
    while (true) {
      let rejected = false;
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        rejected = true;
        failure = error;
      }
      if (!isOwnerCurrent(owner)) return;
      const latest = provider.syncTask;
      if (latest && latest !== pending) {
        pending = latest;
        continue;
      }
      if (rejected) throw failure;
      return;
    }
  };

  const startBackgroundSync = (ctx: ExtensionContext, owner: SessionSelectionOwner): void => {
    void (async () => {
      try {
        await owner.ready;
        if (!isOwnerCurrent(owner)) return;
        await syncAll(ctx, owner);
      } catch (error) {
        if (!isOwnerCurrent(owner)) return;
        try {
          ctx.ui.notify(`Account startup activation failed: ${redactTokenText(errorMessage(error))}`, "error");
        } catch {
          // Detached startup must stay handled if the UI disappears during replacement or reload.
        }
      }
    })();
  };

  const openaiAdapter = adapters.get("openai");
  if (openaiAdapter) {
    openaiRequests = new OpenAIRequests(
      pi,
      store,
      recovery,
      openaiAdapter,
      async (ctx, signal, model) => {
        const owner = await ensureSessionOwner(ctx);
        for (let attempt = 0; attempt < 8; attempt++) {
          signal.throwIfAborted();
          const result = await syncProvider("openai", ctx, owner, signal);
          if (!isOwnerCurrent(owner) || result.status === "error")
            throw new Error("Shared OpenAI account activation failed.");
          const state = await store.readProviderAsync("openai", signal);
          const selection = readSharedSelection(state);
          if (!selection) throw new Error("Shared OpenAI account selection is unavailable.");
          if (selection.account !== (result.status === "active" ? result.accountName : null)) continue;
          const credential =
            selection.account === null ? undefined : getOwnCredential(state.accounts, selection.account);
          if (selection.account !== null && !credential) throw new Error("Shared OpenAI account no longer exists.");
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          const latest = await store.readProviderAsync("openai", signal);
          signal.throwIfAborted();
          if (!isOwnerCurrent(owner)) throw new Error("Accounts session was replaced before request capture.");
          if (readSharedSelection(latest)?.revision !== selection.revision) continue;
          if (
            credential &&
            JSON.stringify(getOwnCredential(latest.accounts, selection.account as string)) !==
              JSON.stringify(credential)
          )
            continue;
          if (
            !auth.ok ||
            auth.apiKey === RUNTIME_FAIL_CLOSED_API_KEY ||
            (credential && auth.apiKey !== (credential.type === "oauth" ? credential.access : credential.key))
          )
            throw new Error("Shared OpenAI account authentication conflicts with the effective request.");
          return { selection, credential, auth };
        }
        throw new Error("Shared OpenAI selection kept changing; no request was sent.");
      },
      (ctx) => {
        const owner = sessionOwners.get(ctx.sessionManager);
        return owner !== undefined && isOwnerCurrent(owner);
      },
      () => {
        const state = store.read().providers.openai;
        return state ? readSharedSelection(state) : undefined;
      },
      dependencies.probe,
    );
    openaiRequests.registerLifecycle();
  }

  registerOAuthCredentialReadiness(pi, [
    {
      waitForCredential(data) {
        const request = parseCredentialReadinessRequest(data);
        if (!request) return;
        const owner = sessionOwners.get(request.session as ExtensionContext["sessionManager"]);
        const providerId = toProviderId(request.provider);
        if (!owner || !providerId) return;
        const pending = waitForCurrentProvider(providerId, owner);
        try {
          request.waitUntil(pending);
        } catch {
          void pending.catch(() => undefined);
        }
      },
    },
  ]);

  const activateAccount = createAccountActivation(
    store,
    adapters,
    (session) => sessionOwners.get(session as ExtensionContext["sessionManager"]),
    isOwnerCurrent,
    persistSelection,
    syncProvider,
  );

  registerAccountsProtocol(
    pi,
    async () => {
      const data = await store.readAsync();
      return {
        providers: providers.map((adapter) => {
          const state = data.providers[adapter.id];
          return {
            providerId: adapter.id,
            displayName: adapter.displayName,
            accounts: Object.entries(state?.accounts ?? {}).map(([name, credential]) => ({
              name,
              kind: credential.type === "api_key" ? ("api-key" as const) : ("oauth" as const),
            })),
            ...(state?.active ? { defaultAccount: state.active } : {}),
          };
        }),
      };
    },
    async (request) => {
      const result = await activateAccount(request);
      if (result.status !== "error") return result;
      return {
        status: result.status,
        providerId: result.providerId,
        accountName: result.accountName,
        code: result.code,
      };
    },
  );

  pi.registerCommand(
    "accounts",
    createAccountCommand(store, adapters, syncProvider, activateAccount, ensureSessionOwner, (owner) => ({
      signal: owner.signal,
      isCurrent: () => isOwnerCurrent(owner),
    })),
  );

  pi.on("session_start", (_event, ctx) => {
    const owner = startSessionOwner(ctx);
    startBackgroundSync(ctx, owner);
  });

  pi.on("model_select", async (event, ctx) => {
    const owner = await ensureSessionOwner(ctx);
    if (!isOwnerCurrent(owner)) return;
    const providerId = toProviderId(event.model.provider);
    if (providerId) {
      const result = await syncProvider(providerId, ctx, owner, undefined, event.model);
      if (isOwnerCurrent(owner) && result.status === "error" && hasEnvironmentSelection(owner)) {
        ctx.ui.notify(
          `${requireAdapter(adapters, providerId).displayName} account selected by PI_ACCOUNT failed closed. Check that the account exists and its authentication is valid.`,
          "error",
        );
      }
    } else updateStatus(ctx, owner.providers, event.model, hasEnvironmentSelection(owner));
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Preflight compaction may recover before this new user run. It already
    // proceeds under the replacement and must not acquire an extra continue.
    openaiRequests?.cancel(ctx);
    const owner = await ensureSessionOwner(ctx);
    for (const provider of owner.providers.values()) provider.abortTurn = false;
    if (!isOwnerCurrent(owner)) return;
    const providerId = toProviderId(ctx.model?.provider);
    if (!providerId) return;
    try {
      const result = owner.providers.get(providerId)?.started
        ? await syncProvider(providerId, ctx, owner)
        : await startupProvider(providerId, ctx, owner);
      if (!isOwnerCurrent(owner)) return;
      const provider = owner.providers.get(providerId);
      if (!provider) return;
      const { coordinator } = provider;
      if (result.status === "error") provider.abortTurn = true;
      if (result.status === "active" && ctx.model && !coordinator.isModelAvailable(ctx.model.id)) {
        provider.abortTurn = true;
        ctx.ui.notify(
          hasEnvironmentSelection(owner)
            ? `${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to the account selected by PI_ACCOUNT.`
            : `${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to account "${result.accountName}".`,
          "error",
        );
      }
    } catch (error) {
      const provider = owner.providers.get(providerId);
      if (provider) provider.abortTurn = true;
      throw error;
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    const owner = sessionOwners.get(ctx.sessionManager);
    if (!owner || !isOwnerCurrent(owner)) return;
    const providerId = toProviderId(ctx.model?.provider);
    const provider = providerId ? owner.providers.get(providerId) : undefined;
    if (!provider?.abortTurn) return;
    provider.abortTurn = false;
    ctx.abort();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const owner = sessionOwners.get(ctx.sessionManager);
    if (!owner) {
      setStatus(ctx, undefined);
      return;
    }
    sessionOwners.delete(ctx.sessionManager);
    openaiRequests?.dispose(ctx);
    await owner.dispose(ctx, true);
    setStatus(ctx, undefined);
  });
}

function createAccountCommand(
  store: AccountStore,
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  syncProvider: SyncProvider,
  activateAccount: ActivateAccount,
  ensureSessionOwner: (ctx: ExtensionContext) => Promise<SessionSelectionOwner>,
  getMenuOwner: (owner: SessionSelectionOwner) => { signal: AbortSignal; isCurrent(): boolean },
) {
  return {
    description: "Open the interactive OAuth and API key account manager",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const owner = await ensureSessionOwner(ctx);
      const menuOwner = getMenuOwner(owner);
      if (!menuOwner.isCurrent()) return;
      const { showAccountsMenu } = await import("./account-menu.js");
      if (!menuOwner.isCurrent()) return;
      await showAccountsMenu(
        ctx,
        store,
        adapters,
        owner,
        {
          login: (adapter, name, signal, isCurrent, method) =>
            loginAccount(ctx, store, adapter, name, signal, syncProvider, activateAccount, owner, isCurrent, method),
          switch: (adapter, name, signal, isCurrent) =>
            switchAccount(ctx, adapter, name, signal, activateAccount, owner, isCurrent),
          remove: (adapter, name, signal, isCurrent) =>
            removeAccount(ctx, store, adapter, name, signal, syncProvider, activateAccount, owner, isCurrent),
        },
        menuOwner,
      );
    },
  };
}

async function loginAccount(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  adapter: AccountProviderAdapter,
  nameArg: string,
  signal: AbortSignal,
  syncProvider: SyncProvider,
  activateAccount: ActivateAccount,
  session: SessionSelectionOwner,
  isCurrent: () => boolean,
  method: "oauth" | "api_key" = "oauth",
): Promise<void> {
  const parsed = parseAccountName(nameArg);
  if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
  if (isDefaultPiLoginArg(parsed.name)) {
    ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("Account login requires interactive UI.", "error");
    return;
  }
  const state = await store.readProviderAsync(adapter.id);
  if (!isCurrent()) return;
  if (getOwnCredential(state.accounts, parsed.name)) {
    const confirmed = await ctx.ui.confirm(
      "Replace account",
      `${adapter.displayName} account "${parsed.name}" already exists. Replace it?`,
    );
    if (!confirmed || !isCurrent()) return;
  }
  ctx.ui.notify(`Starting ${adapter.displayName} login for "${parsed.name}".`, "info");
  let credentialSaved = false;
  let enteredKey: string | undefined;
  try {
    let credential: StoredCredential;
    if (method === "api_key") {
      if (!adapter.supportsApiKey) throw new Error(`${adapter.displayName} does not support API keys.`);
      enteredKey = await ctx.ui.input(`${adapter.displayName} API key (visible input):`, "", { signal });
      if (enteredKey === undefined || !isCurrent() || signal.aborted) return;
      credential = normalizeApiKeyCredential(enteredKey);
    } else {
      credential = normalizeStoredCredential(await loginWithOAuthUI(ctx, adapter, signal), parsed.name);
    }
    if (!isCurrent()) return;
    if (adapter.id === "openai") credential = { ...credential, piAccountsGeneration: randomUUID() };
    await store.updateProvider(adapter.id, (state) =>
      isCurrent()
        ? {
            ...state,
            accounts: defineOwn(state.accounts, parsed.name, credential),
          }
        : state,
    );
    if (!isCurrent()) return;
    credentialSaved = true;
    const result = hasEnvironmentSelection(session)
      ? await syncProvider(adapter.id, ctx, session, signal)
      : await activateAccount({
          session: session.sessionManager,
          provider: adapter.id,
          account: parsed.name,
          signal,
          isCurrent,
        });
    if (!isCurrent()) return;
    ctx.ui.notify(
      hasEnvironmentSelection(session)
        ? `Saved ${adapter.displayName} account "${parsed.name}". PI_ACCOUNT still controls this process's selection.${result.status === "error" ? " Authentication failed closed; check the selected account." : ""}`
        : formatActivationMessage("Logged in", adapter, parsed.name, result),
      result.status === "error" ? "error" : "info",
    );
  } catch (error) {
    if (!isCurrent()) return;
    const message = redactTokenText(errorMessage(error), enteredKey ? [enteredKey] : []);
    ctx.ui.notify(
      credentialSaved
        ? `${adapter.displayName} account "${parsed.name}" was saved, but this session could not select it: ${message}`
        : `${adapter.displayName} login failed: ${message}`,
      "error",
    );
  }
}

async function switchAccount(
  ctx: ExtensionCommandContext,
  adapter: AccountProviderAdapter,
  name: string,
  signal: AbortSignal,
  activateAccount: ActivateAccount,
  session: SessionSelectionOwner,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const account = name === "default" ? null : name;
  const result = await activateAccount({
    session: session.sessionManager,
    provider: adapter.id,
    account,
    signal,
    isCurrent,
  });
  if (!isCurrent()) return;
  if (result.status === "error" && result.code === "account_not_found") {
    ctx.ui.notify(`${adapter.displayName} account "${name}" was not found.`, "warning");
  } else if (result.status === "error" && result.code === "store_unavailable") {
    ctx.ui.notify(
      `Could not save ${adapter.displayName} selection for this session: ${result.message ?? result.code}`,
      "error",
    );
  } else if (account === null && result.status === "inactive") {
    ctx.ui.notify(`Using default Pi ${adapter.displayName} login.`, "info");
  } else if (account === null && result.status === "error" && result.code !== "activation_superseded") {
    ctx.ui.notify(
      `Could not restore default Pi ${adapter.displayName} login; requests will fail closed: ${result.message ?? result.code}`,
      "error",
    );
  } else {
    ctx.ui.notify(
      formatActivationMessage("Activated", adapter, name, result),
      result.status === "active" ? "info" : "error",
    );
  }
}

async function removeAccount(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  adapter: AccountProviderAdapter,
  nameArg: string,
  signal: AbortSignal,
  syncProvider: SyncProvider,
  activateAccount: ActivateAccount,
  session: SessionSelectionOwner,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const parsed = parseAccountName(nameArg);
  if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
  let removed = false;
  let removedSharedSelection = false;
  try {
    await store.updateProvider(adapter.id, (state) => {
      if (!isCurrent() || !getOwnCredential(state.accounts, parsed.name)) return state;
      removed = true;
      removedSharedSelection = adapter.id === "openai" && readSharedSelection(state)?.account === parsed.name;
      const accounts = defineOwnMap(state.accounts);
      delete accounts[parsed.name];
      return {
        ...state,
        active: state.active === parsed.name ? undefined : state.active,
        accounts,
        ...(removedSharedSelection ? { sharedSelection: { account: null, revision: randomUUID() } } : {}),
      };
    });
  } catch {
    if (isCurrent()) ctx.ui.notify("Could not remove the account. Check account storage and try again.", "error");
    return;
  }
  if (!isCurrent()) return;
  if (!removed) {
    ctx.ui.notify(`${adapter.displayName} account "${parsed.name}" was not found.`, "warning");
    return;
  }
  if (hasEnvironmentSelection(session)) {
    if (session.environmentAccount === parsed.name) {
      const result = await syncProvider(adapter.id, ctx, session, signal);
      if (!isCurrent()) return;
      ctx.ui.notify(
        `Removed ${adapter.displayName} account "${parsed.name}". PI_ACCOUNT still selects this name; ${result.status === "error" ? "requests will fail closed until the account is restored or Pi is restarted without PI_ACCOUNT." : "check the effective selection."}`,
        result.status === "error" ? "error" : "warning",
      );
    } else {
      ctx.ui.notify(
        `Removed ${adapter.displayName} account "${parsed.name}". PI_ACCOUNT still controls this process.`,
        "info",
      );
    }
    return;
  }
  const removedSelection =
    adapter.id === "openai" ? removedSharedSelection : !session.error && session.selections[adapter.id] === parsed.name;
  if (removedSelection) {
    // OpenAI deletion already atomically replaced its shared selection under the store lock.
    // Reconcile that selection instead of publishing over another process's newer choice.
    const result =
      adapter.id === "openai"
        ? await syncProvider(adapter.id, ctx, session, signal)
        : await activateAccount({
            session: session.sessionManager,
            provider: adapter.id,
            account: null,
            signal,
            isCurrent,
          });
    if (result.status === "error" && result.code === "store_unavailable") {
      await syncProvider(adapter.id, ctx, session, signal);
      if (isCurrent())
        ctx.ui.notify(
          `Removed ${adapter.displayName} account "${parsed.name}", but this session could not save its default selection and will fail closed: ${result.message}`,
          "error",
        );
      return;
    }
    if (!isCurrent()) return;
    if (result.status === "error") {
      ctx.ui.notify(
        `Removed ${adapter.displayName} account "${parsed.name}", but default auth restoration failed closed: ${result.message}`,
        "error",
      );
      return;
    }
  }
  ctx.ui.notify(`Removed ${adapter.displayName} account "${parsed.name}".`, "info");
}

function validateProviderSet(providers: readonly AccountProviderAdapter[], requireAll: boolean): void {
  const ids = new Set<AccountProviderId>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`Duplicate account provider: ${provider.id}`);
    ids.add(provider.id);
  }
  if (!requireAll) return;
  for (const id of SUPPORTED_PROVIDER_IDS) {
    if (!ids.has(id)) throw new Error(`Missing required account provider: ${id}`);
  }
}

function requireAdapter(
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  providerId: AccountProviderId,
): AccountProviderAdapter {
  const adapter = adapters.get(providerId);
  if (!adapter) throw new Error(`Unsupported account provider: ${providerId}`);
  return adapter;
}

function toProviderId(value: string | undefined): AccountProviderId | undefined {
  return value && isAccountProviderId(value) ? value : undefined;
}

function isAccountProviderId(value: string): value is AccountProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

function isDefaultPiLoginArg(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "default" || normalized === "--default" || normalized === DEFAULT_PI_LOGIN_LABEL;
}

function formatActivationMessage(
  action: "Logged in" | "Activated",
  adapter: AccountProviderAdapter,
  name: string,
  result: EnsureActiveProviderAuthResult | AccountActivationOutcome,
): string {
  if (result.status === "error" && result.code === "activation_superseded") {
    return `${action} ${adapter.displayName} account "${name}" was superseded before activation.`;
  }
  if (result.status !== "inactive" && result.accountName !== "unknown" && result.accountName !== name) {
    return `${action} ${adapter.displayName} account "${name}" was superseded by "${result.accountName}" before activation.`;
  }
  if (result.status === "error") {
    return `${action} ${adapter.displayName} account "${name}", but authentication failed; requests will fail closed: ${result.message ?? result.code ?? "activation_failed"}`;
  }
  if (result.status === "inactive") {
    return `${action} ${adapter.displayName} account "${name}" was superseded before activation.`;
  }
  return `${action} ${adapter.displayName} account "${name}".`;
}

async function selectedCredential(
  store: AccountStore,
  providerId: AccountProviderId,
  result: EnsureActiveProviderAuthResult,
  signal?: AbortSignal,
): Promise<StoredCredential | undefined> {
  if (result.status === "inactive") return undefined;
  try {
    const state = await store.readProviderAsync(providerId, signal);
    return getOwnCredential(state.accounts, result.accountName);
  } catch {
    return undefined;
  }
}

function updateStatus(
  ctx: ExtensionContext,
  providers: ReadonlyMap<AccountProviderId, ProviderSessionState>,
  model = ctx.model,
  fromEnvironment = false,
): void {
  const providerId = toProviderId(model?.provider);
  const result = providerId ? providers.get(providerId)?.result : undefined;
  if (!result || result.status === "inactive") {
    setStatus(ctx, undefined);
    return;
  }
  if (result.status === "active") {
    setStatus(ctx, fromEnvironment ? "account:PI_ACCOUNT" : `account:${result.accountName}`);
    return;
  }
  setStatus(ctx, fromEnvironment ? "account:PI_ACCOUNT auth error" : `account:${result.accountName} auth error`);
}

function hasEnvironmentSelection(owner: SessionSelectionOwner): boolean {
  return owner.environmentAccount !== undefined || owner.environmentError !== undefined;
}

function readEnvironmentAccount(): { account?: string; error?: string } {
  const value = process.env.PI_ACCOUNT;
  if (value === undefined) return {};
  const parsed = parseAccountName(value);
  if (parsed.ok && !isDefaultPiLoginArg(parsed.name)) return { account: parsed.name };
  return {
    error:
      "PI_ACCOUNT must name a saved account (1-64 letters, numbers, dots, underscores, or hyphens; not default). Unset it and restart Pi to restore session selection.",
  };
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
  try {
    ctx.ui.setStatus(ACCOUNTS_STATUS_KEY, value);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

function isStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("This extension ctx is stale after session replacement or reload")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
