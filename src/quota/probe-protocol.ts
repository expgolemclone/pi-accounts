import type { Api, Model, ModelAuth } from "@earendil-works/pi-ai";
import { isQuotaFailureReason, type QuotaFailureReason } from "../quota-failure.js";

export type ProbeInput = {
  sdk: string;
  ai: string;
  directory: string;
  model: Model<Api>;
  auth: ModelAuth & { apiKey: string };
};

export type ProbeReply = { kind: "ready" | "pong" | "quota" } | { kind: "failed"; reason: QuotaFailureReason };

export function parseProbeReply(value: unknown): ProbeReply | undefined {
  if (!value || typeof value !== "object") return;
  const reply = value as Partial<{ kind: unknown; reason: unknown }>;
  if (reply.kind === "ready" || reply.kind === "pong" || reply.kind === "quota") return { kind: reply.kind };
  if (reply.kind === "failed" && isQuotaFailureReason(reply.reason)) return { kind: "failed", reason: reply.reason };
  return undefined;
}
