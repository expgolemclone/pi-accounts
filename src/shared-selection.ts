import { randomInt, randomUUID } from "node:crypto";
import {
  type AccountStore,
  credentialGeneration,
  defineOwn,
  getOwnCredential,
  type ProviderAccountsData,
  parseAccountName,
} from "./account-store.js";

export type SharedSelection = { account: string | null; revision: string };

export function readSharedSelection(state: ProviderAccountsData): SharedSelection | undefined {
  const value = state.sharedSelection;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shared OpenAI selection.");
  const { account, revision } = value as Partial<SharedSelection>;
  if (
    typeof revision !== "string" ||
    !revision ||
    (account !== null && (typeof account !== "string" || !parseAccountName(account).ok || account.trim() !== account))
  ) {
    throw new Error("Invalid shared OpenAI selection.");
  }
  return { account: account as string | null, revision };
}

export function chooseOpenAIAccount(
  state: ProviderAccountsData | undefined,
  attempted: ReadonlySet<string> = new Set(),
  draw: (max: number) => number = randomInt,
): string | undefined {
  const names = Object.entries(state?.accounts ?? {})
    .filter(([name, credential]) => credential.type === "oauth" && !attempted.has(name))
    .map(([name]) => name);
  return names.length ? names[draw(names.length)] : undefined;
}

/** The account store is the sole authority. No session snapshot may publish over it. */
export class OpenAISelection {
  constructor(private readonly store: AccountStore) {}

  async ensure(signal?: AbortSignal): Promise<SharedSelection> {
    let state = await this.store.readProviderAsync("openai", signal);
    const existing = readSharedSelection(state);
    if (existing && Object.values(state.accounts).every((credential) => credentialGeneration(credential)))
      return existing;
    state = await this.store.updateProviderAsync(
      "openai",
      async (latest) => {
        for (const [name, credential] of Object.entries(latest.accounts)) {
          if (!credentialGeneration(credential))
            latest.accounts = defineOwn(latest.accounts, name, {
              ...credential,
              piAccountsGeneration: randomUUID(),
            });
        }
        if (readSharedSelection(latest)) return latest;
        const account =
          latest.active && getOwnCredential(latest.accounts, latest.active)
            ? latest.active
            : (chooseOpenAIAccount(latest) ?? null);
        return { ...latest, active: account ?? undefined, sharedSelection: { account, revision: randomUUID() } };
      },
      signal,
    );
    const selection = readSharedSelection(state);
    if (!selection) throw new Error("Could not establish the shared OpenAI selection.");
    return selection;
  }

  async select(
    account: string | null,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
    expectedRevision?: string,
    expectedGeneration?: string,
  ): Promise<SharedSelection | undefined> {
    let published: SharedSelection | undefined;
    await this.store.updateProviderAsync(
      "openai",
      async (state) => {
        signal?.throwIfAborted();
        if (
          !isCurrent() ||
          (expectedRevision !== undefined && readSharedSelection(state)?.revision !== expectedRevision)
        )
          return state;
        if (account !== null && !getOwnCredential(state.accounts, account))
          throw new Error("OpenAI account no longer exists.");
        if (account !== null && expectedGeneration !== undefined) {
          if (credentialGeneration(getOwnCredential(state.accounts, account)) !== expectedGeneration) return state;
        }
        published = { account, revision: randomUUID() };
        return { ...state, active: account ?? undefined, sharedSelection: published };
      },
      signal,
    );
    return published;
  }
}
