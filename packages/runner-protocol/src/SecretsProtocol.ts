import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { RunId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jsonCodec } from "./jsonCodec.ts";
import { SecretValue } from "./SecretScrubber.ts";

/**
 * A thread's secrets (#395): the 1Password Environments its folders name,
 * which the Runner reads with the owner's 1Password service account when a
 * harness session starts, and hands the harness as environment variables.
 * Everything the Runner sends back has them scrubbed (`SecretScrubber.ts`).
 *
 * The token travels with each `turn.start` and is never written to the
 * machine's disk or environment.
 *
 * The model must never see a value either (#591), and the harness talks to it
 * through the ModelGateway, not the Runner. Only the machine can read the
 * values (1Password's SDK doesn't run in a Worker), so before a harness
 * session gets them the Runner registers them with its thread
 * (`SESSION_PATHS.secrets`, with the session token). The thread keeps them for the gateway, which
 * scrubs every model request of the turn, and refuses a turn's requests while
 * its secrets aren't registered by the machine running it.
 */
export const SecretsAccess = Schema.Struct({
  /** The owner's 1Password service account token. Null: none connected, so nothing loads. */
  token: Schema.NullOr(Schema.String),
  /** Top level first; a nearer folder's variable replaces one of the same name from above. */
  environments: Schema.Array(OnePasswordEnvironmentId),
  /**
   * This machine's outbound requests pass through the thread's egress check
   * (#592), which asks before a secret goes to a new host. Only on a guarded
   * machine can its broker resolve placeholders; local files and commands
   * keep them literal. Absent: placeholders stay literal everywhere.
   */
  guarded: Schema.optionalKey(Schema.Boolean),
});
export type SecretsAccess = typeof SecretsAccess.Type;

/**
 * Every value the machine hides, sent whenever it loads them: an empty list
 * still says the machine has none. Values only join; the thread keeps every
 * one it was given, since an old value may still sit in the conversation.
 */
export const SecretsRegistration = Schema.Struct({
  /** The turn this registration belongs to; session tokens live across turns. */
  runId: RunId,
  /** Every hidden value read for this turn, added to the thread's redaction history. */
  secrets: Schema.Array(SecretValue),
  /** The nearest hidden value for each name, used for outbound placeholders only. */
  current: Schema.Array(SecretValue),
  /**
   * The Environment each secret came from right now, nearest folder winning:
   * what the person's "always send" answers are kept against (#592). Absent
   * from a Runner older than this field.
   */
  sources: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, environment: OnePasswordEnvironmentId })),
  ),
});
export type SecretsRegistration = typeof SecretsRegistration.Type;

export const secretsJson = { registration: jsonCodec(SecretsRegistration) };
