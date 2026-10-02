/** Shorthands for writing team conversation fixtures. */
import type { HarnessRef, MessageAuthor, SystemEvent } from "./multiplayerModel";

export const CODEX: HarnessRef = { provider: "codex", model: "GPT-5.4" };
export const SONNET: HarnessRef = { provider: "claudeAgent", model: "Claude Sonnet 4.5" };

export const person = (personId: string): MessageAuthor => ({ kind: "person", personId });
export const agent = (startedById: string, harness: HarnessRef): MessageAuthor => ({
  kind: "agent",
  name: harness.provider === "codex" ? "Codex" : "Claude",
  startedById,
  harness,
});
export const system = (event: SystemEvent): MessageAuthor => ({ kind: "system", event });
