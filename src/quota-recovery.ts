import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AccountStore, credentialGeneration, getOwnCredential, type StoredCredential } from "./account-store.js";
import { QuotaRecoveryError } from "./quota-failure.js";
import {
  chooseOpenAIAccount,
  type OpenAISelection,
  readSharedSelection,
  type SharedSelection,
} from "./shared-selection.js";
import { type AccountStorageBackend, FileAccountStorageBackend } from "./storage.js";

export type RecoveryResult = { status: "ready"; revision: string } | { status: "stopped"; message: string };
type Round = { owner: string; startedAt: number; deadline: number; result?: RecoveryResult };
type RecoveryData = { version: 1; rounds: Record<string, Round>; [key: string]: unknown };
export type CandidateProbe = (
  name: string,
  credential: StoredCredential,
  signal: AbortSignal,
) => Promise<"pong" | "quota">;
const ROUND_TIMEOUT_MS = 180_000;
const SUPERSEDED_ROUND: RecoveryResult = {
  status: "stopped",
  message: "A newer OpenAI recovery round superseded this failure. No automatic retry was scheduled.",
};

function parse(raw: string | undefined): RecoveryData {
  const value = raw === undefined ? { version: 1, rounds: {} } : JSON.parse(raw);
  if (value?.version !== 1 || !value.rounds || typeof value.rounds !== "object" || Array.isArray(value.rounds)) {
    throw new Error("Invalid accounts recovery.json.");
  }
  const rounds = Object.create(null) as Record<string, Round>;
  for (const [revision, item] of Object.entries(value.rounds)) {
    const round = item as Partial<Round> | null;
    if (
      !revision ||
      !round ||
      typeof round !== "object" ||
      typeof round.owner !== "string" ||
      !round.owner ||
      !Number.isSafeInteger(round.startedAt) ||
      (round.startedAt as number) < 0 ||
      !Number.isSafeInteger(round.deadline) ||
      (round.deadline as number) < 0 ||
      (round.result !== undefined &&
        (!round.result ||
          (round.result.status === "ready"
            ? typeof round.result.revision !== "string" || !round.result.revision
            : round.result.status !== "stopped" || typeof round.result.message !== "string")))
    ) {
      throw new Error("Invalid accounts recovery.json.");
    }
    rounds[revision] = round as Round;
  }
  return { ...value, rounds };
}

/** Short atomic elections/results only; inference and waiter delays never hold any file lock. */
export class QuotaRecovery {
  constructor(
    private readonly store: AccountStore,
    private readonly selection: OpenAISelection,
    private readonly backend: AccountStorageBackend = new FileAccountStorageBackend(
      join(getAgentDir(), "extensions", "accounts", "recovery.json"),
    ),
    private readonly timeoutMs = ROUND_TIMEOUT_MS,
  ) {}

  /** Only a request begun after a stopped round may authorize its next election. */
  async retryToken(selection: SharedSelection, signal?: AbortSignal): Promise<string | undefined> {
    return this.backend.readAsync(async (raw) => {
      const round = parse(raw).rounds[selection.revision];
      return round?.result?.status === "stopped" ? round.owner : undefined;
    }, signal);
  }

  async recover(
    failed: SharedSelection,
    probe: CandidateProbe,
    signal: AbortSignal,
    retryToken?: string,
  ): Promise<RecoveryResult> {
    signal.throwIfAborted();
    const owner = randomUUID();
    const round = await this.backend.withLockAsync(async (raw) => {
      const data = parse(raw);
      const shared = readSharedSelection(await this.store.readProviderAsync("openai", signal));
      // Keep only the active failed revision and its verified predecessor. Older
      // outcomes cannot authorize continue under today's selection, even for late errors.
      for (const [revision, value] of Object.entries(data.rounds)) {
        if (
          revision !== shared?.revision &&
          !(value.result?.status === "ready" && value.result.revision === shared?.revision)
        ) {
          delete data.rounds[revision];
        }
      }
      const existing = data.rounds[failed.revision];
      if (!existing && shared?.revision !== failed.revision) {
        const stopped: Round = {
          owner,
          startedAt: Date.now(),
          deadline: Date.now(),
          result: {
            status: "stopped",
            message: "A newer shared OpenAI selection superseded this failure.",
          },
        };
        return { result: stopped, next: `${JSON.stringify(data, null, 2)}\n` };
      }
      if (existing && !(existing.result?.status === "stopped" && existing.owner === retryToken)) {
        return { result: existing };
      }
      const startedAt = Date.now();
      const created: Round = { owner, startedAt, deadline: startedAt + this.timeoutMs };
      data.rounds[failed.revision] = created;
      return { result: created, next: `${JSON.stringify(data, null, 2)}\n` };
    }, signal);
    if (round.result) return round.result;
    if (round.owner !== owner) return this.wait(failed.revision, round, signal);
    let result: RecoveryResult;
    const deadline = AbortSignal.timeout(Math.max(1, round.deadline - Date.now()));
    const operation = AbortSignal.any([signal, deadline]);
    try {
      result = await this.lead(failed, round, probe, operation);
    } catch (error) {
      result = {
        status: "stopped",
        message: operation.aborted
          ? "OpenAI account recovery cancelled or timed out. No automatic retry was scheduled."
          : error instanceof QuotaRecoveryError
            ? error.message
            : "OpenAI account recovery stopped. Check account authentication, storage and transport.",
      };
    }
    // Publish cancellation too, so other processes stop waiting. Never use the cancelled
    // operation signal for the short cleanup transaction.
    return this.finish(failed.revision, round, result);
  }

  private async finish(revision: string, round: Round, result: RecoveryResult): Promise<RecoveryResult> {
    return this.backend.withLockAsync(async (raw) => {
      const data = parse(raw);
      const current = data.rounds[revision];
      if (!current || current.owner !== round.owner) return { result: SUPERSEDED_ROUND };
      if (current.result) return { result: current.result };
      current.result = result;
      return { result, next: `${JSON.stringify(data, null, 2)}\n` };
    });
  }

  private async wait(revision: string, round: Round, signal: AbortSignal): Promise<RecoveryResult> {
    while (true) {
      signal.throwIfAborted();
      const current = await this.backend.readAsync(async (raw) => parse(raw).rounds[revision], signal);
      if (!current || current.owner !== round.owner) return SUPERSEDED_ROUND;
      if (current.result) return current.result;
      if (Date.now() >= round.deadline)
        return this.finish(revision, round, {
          status: "stopped",
          message: "OpenAI recovery representative did not finish before its deadline. No new probe was started.",
        });
      await delay(Math.min(100, Math.max(1, round.deadline - Date.now())), undefined, { signal });
    }
  }

  private async lead(
    failed: SharedSelection,
    round: Round,
    probe: CandidateProbe,
    signal: AbortSignal,
  ): Promise<RecoveryResult> {
    const attempted = new Set<string>(failed.account === null ? [] : [failed.account]);
    while (true) {
      signal.throwIfAborted();
      const state = await this.store.readProviderAsync("openai", signal);
      if (readSharedSelection(state)?.revision !== failed.revision)
        return {
          status: "stopped",
          message: "OpenAI shared selection changed; pending quota recovery was superseded.",
        };
      const candidate = chooseOpenAIAccount(state, attempted);
      if (candidate === undefined)
        return {
          status: "stopped",
          message: "No untried OpenAI OAuth accounts remain. Select an account or send a new request to retry.",
        };
      attempted.add(candidate);
      const credential = getOwnCredential(state.accounts, candidate);
      const generation = credentialGeneration(credential);
      if (!credential || !generation) throw new Error("OpenAI probe account unavailable.");
      const watchController = new AbortController();
      const probeController = new AbortController();
      const probeSignal = AbortSignal.any([signal, probeController.signal]);
      const watchSignal = AbortSignal.any([signal, watchController.signal]);
      // Bounded polling exists only during this explicitly requested recovery. A manual
      // switch cancels the owned child; it never competes with a late probe publication.
      const watch = (async () => {
        try {
          while (!watchSignal.aborted) {
            await delay(100, undefined, { signal: watchSignal });
            const latest = await this.store.readProviderAsync("openai", watchSignal);
            if (readSharedSelection(latest)?.revision !== failed.revision) {
              probeController.abort();
              return;
            }
          }
        } catch {
          if (!watchSignal.aborted) probeController.abort();
        }
      })();
      let outcome: "pong" | "quota";
      try {
        outcome = await probe(candidate, credential, probeSignal);
      } finally {
        watchController.abort();
        await watch;
      }
      probeSignal.throwIfAborted();
      const latest = await this.store.readProviderAsync("openai", signal);
      if (credentialGeneration(getOwnCredential(latest.accounts, candidate)) !== generation) {
        throw new Error("OpenAI probe account was replaced.");
      }
      if (outcome === "quota") continue;
      // Serialize result publication with waiter expiry. No inference runs under this
      // lock; a timed-out/dead representative cannot publish after its round stopped.
      return this.backend.withLockAsync(async (raw) => {
        const data = parse(raw);
        const current = data.rounds[failed.revision];
        if (!current || current.owner !== round.owner) return { result: SUPERSEDED_ROUND };
        if (current.result) return { result: current.result };
        signal.throwIfAborted();
        const published = await this.selection.select(
          candidate,
          signal,
          () => !signal.aborted && Date.now() < round.deadline,
          failed.revision,
          generation,
        );
        const result: RecoveryResult = published
          ? { status: "ready", revision: published.revision }
          : {
              status: "stopped",
              message: "A newer OpenAI selection or credential superseded the verified probe.",
            };
        current.result = result;
        return { result, next: `${JSON.stringify(data, null, 2)}\n` };
      }, signal);
    }
  }
}
