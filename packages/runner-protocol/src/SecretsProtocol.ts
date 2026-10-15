import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import * as Schema from "effect/Schema";

/**
 * A thread's secrets (#395): the 1Password Environments its folders name,
 * which the Runner reads with the owner's 1Password service account when a
 * harness session starts, and hands the harness as environment variables.
 * Signalbox stores only which Environments, never a value. The values stay
 * on the machine: everything the Runner sends back has them masked.
 *
 * The token travels with each `turn.start` and is never written to the
 * machine's disk or environment.
 */
export const SecretsAccess = Schema.Struct({
  /** The owner's 1Password service account token. Null: none connected, so nothing loads. */
  token: Schema.NullOr(Schema.String),
  /** Top level first; a nearer folder's variable replaces one of the same name from above. */
  environments: Schema.Array(OnePasswordEnvironmentId),
});
export type SecretsAccess = typeof SecretsAccess.Type;

/** What a masked secret reads as in anything the Runner sends. */
export const SECRET_MASK = "***";
