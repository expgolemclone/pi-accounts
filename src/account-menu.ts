import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AccountStore, defineOwnMap, getOwnCredential, type StoredCredential } from "./account-store.js";
import { type AccountProviderAdapter, type AccountProviderId, SUPPORTED_PROVIDER_IDS } from "./oauth.js";
import type { ProviderAccountSelections } from "./session-selection.js";
import { readSharedSelection } from "./shared-selection.js";

const LOGIN_ACTION = "Login new account";
const API_KEY_ACTION = "Add API key account";
const DEFAULT_ACTION = "Set default account";
const REMOVE_ACTION = "Remove account";
const SWITCH_PROVIDER_ACTION = "Switch provider account";
const SWITCH_ANOTHER_PROVIDER_ACTION = "Switch another provider’s account";

type AccountMenuSession = {
  selections: ProviderAccountSelections;
  error?: string;
  environmentAccount?: string;
  environmentError?: string;
};

type AccountMenuOwner = {
  signal: AbortSignal;
  isCurrent(): boolean;
};

type AccountMenuHandlers = {
  login(
    adapter: AccountProviderAdapter,
    name: string,
    signal: AbortSignal,
    isCurrent: () => boolean,
    method?: "oauth" | "api_key",
  ): Promise<void>;
  switch(adapter: AccountProviderAdapter, name: string, signal: AbortSignal, isCurrent: () => boolean): Promise<void>;
  remove(adapter: AccountProviderAdapter, name: string, signal: AbortSignal, isCurrent: () => boolean): Promise<void>;
};

type ProviderMenuState = {
  id: AccountProviderId;
  adapter: AccountProviderAdapter;
  active: string | undefined;
  defaultAccount: string | undefined;
  selectionInvalid: boolean;
  accounts: Record<string, StoredCredential>;
};

export async function showAccountsMenu(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  session: AccountMenuSession,
  handlers: AccountMenuHandlers,
  owner: AccountMenuOwner,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/accounts requires interactive UI (TUI or RPC mode).", "error");
    return;
  }
  const isCurrent = () => owner.isCurrent() && !owner.signal.aborted;
  const fromEnvironment = session.environmentAccount !== undefined || session.environmentError !== undefined;
  const readStates = () => readProviderMenuStates(store, adapters, session);

  async function select(title: string, options: string[]): Promise<string | undefined> {
    if (!isCurrent()) return undefined;
    const choice = await ctx.ui.select(title, options, { signal: owner.signal });
    return isCurrent() && choice !== undefined && options.includes(choice) ? choice : undefined;
  }

  async function selectProvider(title: string, providers: ProviderMenuState[]): Promise<ProviderMenuState | undefined> {
    const choice = await select(
      title,
      providers.map((provider) => provider.adapter.displayName),
    );
    return providers.find((provider) => provider.adapter.displayName === choice);
  }

  async function switchAccount(providerId: AccountProviderId): Promise<boolean> {
    while (isCurrent()) {
      const provider = (await readStates()).get(providerId);
      if (!provider || !isCurrent()) return true;
      const name = await select(
        `Switch ${provider.adapter.displayName} account\nCurrent account: ${provider.active ?? "default"}`,
        switchAccountOptions(provider.active, accountNames(provider), provider.selectionInvalid),
      );
      if (!isCurrent()) return true;
      if (name === undefined) return false;
      if (fromEnvironment) {
        ctx.ui.notify(
          "PI_ACCOUNT controls this process's account selection. Unset it and restart Pi to switch accounts.",
          "warning",
        );
        return false;
      }
      await handlers.switch(provider.adapter, name, owner.signal, isCurrent);
      return true;
    }
    return true;
  }

  async function setDefault(): Promise<boolean> {
    while (isCurrent()) {
      const providers = sortedProviderStates(await readStates()).filter((provider) => provider.id !== "openai");
      const provider = await selectProvider(
        "Default accounts for new sessions\nUser-wide settings. Existing sessions keep their own accounts.",
        providers,
      );
      if (!provider) return false;
      while (isCurrent()) {
        const latest = (await readStates()).get(provider.id);
        if (!latest || !isCurrent()) return true;
        const options = [
          ...(latest.defaultAccount === undefined ? [] : ["Pi built-in login"]),
          ...accountNames(latest).filter((name) => name !== latest.defaultAccount),
        ];
        const choice = await select(
          `Default ${provider.adapter.displayName} account\nSaved default: ${latest.defaultAccount ?? "Pi built-in login"}\nApplies to new sessions only. Selecting an account saves immediately.`,
          options,
        );
        if (!isCurrent()) return true;
        if (choice === undefined) break;
        const name = choice === "Pi built-in login" ? undefined : choice;
        try {
          const saved = await store.updateProvider(provider.id, (state) => {
            if (!isCurrent()) throw new DOMException("Menu closed", "AbortError");
            if (name !== undefined && !getOwnCredential(state.accounts, name))
              throw new Error("Account no longer exists");
            return { ...state, active: name };
          });
          if (isCurrent()) {
            ctx.ui.notify(
              `Default ${provider.adapter.displayName} account for new sessions: ${saved.active ?? "Pi built-in login"}. This session is unchanged.`,
              "info",
            );
          }
          return true;
        } catch {
          if (!isCurrent()) return true;
          ctx.ui.notify("Could not save the default account. Check account storage and try again.", "error");
        }
      }
    }
    return true;
  }

  async function removeAccount(): Promise<boolean> {
    while (isCurrent()) {
      const options = removeAccountOptions(await readStates(), toProviderId(ctx.model?.provider));
      const choice = await select(
        "Remove account",
        options.map((option) => option.label),
      );
      if (!isCurrent()) return true;
      const option = options.find((option) => option.label === choice);
      if (!option) return false;
      const latest = await store.readProviderAsync(option.adapter.id);
      if (!isCurrent()) return true;
      if (!getOwnCredential(latest.accounts, option.accountName)) continue;
      const confirmed = await ctx.ui.confirm(
        "Remove account",
        `Remove ${option.adapter.displayName} account "${option.accountName}"?`,
        { signal: owner.signal },
      );
      if (confirmed && isCurrent()) {
        await handlers.remove(option.adapter, option.accountName, owner.signal, isCurrent);
      }
      return true;
    }
    return true;
  }

  while (isCurrent()) {
    const states = await readStates();
    if (!isCurrent()) return;
    const currentProviderId = toProviderId(ctx.model?.provider);
    const currentState = currentProviderId ? states.get(currentProviderId) : undefined;
    const hasAnyStoredAccount = [...states.values()].some((state) => accountNames(state).length > 0);
    const selectionError =
      (session.environmentAccount !== undefined && session.error
        ? "The saved session selection is unavailable, but PI_ACCOUNT remains effective. Unset it and restart Pi to repair via /accounts."
        : session.error) ??
      session.environmentError ??
      ([...states.values()].some((state) => state.selectionInvalid)
        ? session.environmentAccount !== undefined
          ? "PI_ACCOUNT names an account that is unavailable for at least one provider. Save it or unset PI_ACCOUNT and restart Pi."
          : "A selected account is no longer available. Choose an account or default to recover."
        : undefined);
    const options = [
      ...mainOptions(states, currentState, hasAnyStoredAccount, selectionError !== undefined).filter(
        (option) => !fromEnvironment || option === LOGIN_ACTION || option === REMOVE_ACTION,
      ),
      ...([...states.values()].some((provider) => provider.adapter.supportsApiKey) ? [API_KEY_ACTION] : []),
      DEFAULT_ACTION,
    ];
    const choice = await select(
      formatAccountsMenuTitle(ctx, states, hasAnyStoredAccount, selectionError, fromEnvironment),
      options,
    );
    if (choice === undefined) return;
    if (choice === DEFAULT_ACTION) {
      if (await setDefault()) return;
    } else if (choice === REMOVE_ACTION) {
      if (await removeAccount()) return;
    } else if (choice === LOGIN_ACTION || choice === API_KEY_ACTION) {
      const method = choice === API_KEY_ACTION ? "api_key" : "oauth";
      const provider = await selectProvider(
        "Select provider",
        sortedProviderStates(states).filter((provider) => method === "oauth" || provider.adapter.supportsApiKey),
      );
      if (!isCurrent()) return;
      if (!provider) continue;
      const name = await ctx.ui.input(`Name this ${provider.adapter.displayName} account:`, "work", {
        signal: owner.signal,
      });
      if (name !== undefined && isCurrent())
        await handlers.login(provider.adapter, name, owner.signal, isCurrent, method);
      return;
    } else if (currentState && choice === switchCurrentProviderAction(currentState.adapter)) {
      if (await switchAccount(currentState.id)) return;
    } else {
      while (isCurrent()) {
        const provider = await selectProvider(
          "Select provider",
          providerStatesWithAccounts(await readStates(), currentProviderId, selectionError !== undefined),
        );
        if (!provider) break;
        if (await switchAccount(provider.id)) return;
      }
    }
  }
}

async function readProviderMenuStates(
  store: AccountStore,
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  session: AccountMenuSession,
): Promise<Map<AccountProviderId, ProviderMenuState>> {
  const data = await store.readAsync();
  const states = new Map<AccountProviderId, ProviderMenuState>();
  for (const [id, adapter] of adapters) {
    const state = data.providers[id] ?? { accounts: defineOwnMap({}) };
    const active =
      id === "openai"
        ? (readSharedSelection(state)?.account ?? undefined)
        : (session.environmentAccount ?? session.selections[id] ?? undefined);
    states.set(id, {
      id,
      adapter,
      active,
      defaultAccount: state.active,
      selectionInvalid:
        (id !== "openai" && session.environmentAccount === undefined && session.error !== undefined) ||
        session.environmentError !== undefined ||
        (active !== undefined && !getOwnCredential(state.accounts, active)),
      accounts: state.accounts,
    });
  }
  return states;
}

function formatAccountsMenuTitle(
  ctx: ExtensionCommandContext,
  states: Map<AccountProviderId, ProviderMenuState>,
  hasAnyStoredAccount: boolean,
  selectionError?: string,
  fromEnvironment = false,
): string {
  if (!hasAnyStoredAccount && !selectionError && !fromEnvironment) {
    return "Accounts\n\nNo saved accounts yet.\n\nWhat do you want to do?";
  }
  const providerId = toProviderId(ctx.model?.provider);
  const providerName = (providerId && states.get(providerId)?.adapter.displayName) || ctx.model?.provider;
  return [
    "Accounts",
    ...(fromEnvironment
      ? ["", "Account selection source: PI_ACCOUNT (process override). Unset it and restart Pi to switch accounts."]
      : []),
    ...(selectionError ? ["", `Selection error: ${terminalText(selectionError)}`] : []),
    "",
    "Current model:",
    ctx.model ? terminalText(`${providerName} / ${ctx.model.id}`) : "(none)",
    "",
    "Active accounts:",
    ...sortedProviderStates(states).map(
      (state) =>
        `${state.adapter.displayName}: ${state.selectionInvalid ? "recovery required" : fromEnvironment ? "PI_ACCOUNT" : (state.active ?? "default")}`,
    ),
    "",
    "What do you want to do?",
  ].join("\n");
}

function terminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\t\r\n\u0085\u2028\u2029]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
}

function mainOptions(
  states: Map<AccountProviderId, ProviderMenuState>,
  currentState: ProviderMenuState | undefined,
  hasAnyStoredAccount: boolean,
  selectionInvalid: boolean,
): string[] {
  if (!hasAnyStoredAccount && !selectionInvalid) return [LOGIN_ACTION];
  if (currentState && (accountNames(currentState).length > 0 || currentState.selectionInvalid)) {
    return [
      switchCurrentProviderAction(currentState.adapter),
      LOGIN_ACTION,
      ...(hasAnyStoredAccount ? [REMOVE_ACTION] : []),
      ...(providerStatesWithAccounts(states, currentState.id, selectionInvalid).length > 0
        ? [SWITCH_ANOTHER_PROVIDER_ACTION]
        : []),
    ];
  }
  return [
    LOGIN_ACTION,
    currentState ? SWITCH_ANOTHER_PROVIDER_ACTION : SWITCH_PROVIDER_ACTION,
    ...(hasAnyStoredAccount ? [REMOVE_ACTION] : []),
  ];
}

function switchCurrentProviderAction(adapter: AccountProviderAdapter): string {
  return `Switch ${adapter.displayName} account`;
}

function sortedProviderStates(states: Map<AccountProviderId, ProviderMenuState>): ProviderMenuState[] {
  return [...states.values()].sort((left, right) => left.adapter.displayName.localeCompare(right.adapter.displayName));
}

function providerStatesWithAccounts(
  states: Map<AccountProviderId, ProviderMenuState>,
  excludeProviderId?: AccountProviderId,
  includeEmpty = false,
): ProviderMenuState[] {
  return sortedProviderStates(states).filter(
    (state) => state.id !== excludeProviderId && (includeEmpty || accountNames(state).length > 0),
  );
}

function accountNames(state: ProviderMenuState): string[] {
  return Object.keys(state.accounts).sort();
}

function switchAccountOptions(activeName: string | undefined, names: string[], selectionInvalid = false): string[] {
  const active = activeName ?? "default";
  return [
    ...names.filter((name) => selectionInvalid || name !== active),
    ...(selectionInvalid || active !== "default" ? ["default"] : []),
  ];
}

function removeAccountOptions(
  states: Map<AccountProviderId, ProviderMenuState>,
  currentProviderId?: AccountProviderId,
): Array<{ label: string; adapter: AccountProviderAdapter; accountName: string }> {
  const providers = providerStatesWithAccounts(states);
  const currentIndex = providers.findIndex((state) => state.id === currentProviderId);
  if (currentIndex > 0) {
    const [current] = providers.splice(currentIndex, 1);
    if (current) providers.unshift(current);
  }
  return providers.flatMap((state) =>
    accountNames(state).map((accountName) => ({
      label: `${state.adapter.displayName} · ${accountName}`,
      adapter: state.adapter,
      accountName,
    })),
  );
}

function toProviderId(value: string | undefined): AccountProviderId | undefined {
  return value && (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as AccountProviderId)
    : undefined;
}
