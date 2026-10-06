/**
 * The account hub is the CLIProxyAPI instance Signalbox routes pooled
 * accounts through: one Signalbox runs itself, or one the user already runs.
 * It reports limits as an ordinary usage limit source with this fixed id, so
 * clients can tell it apart from a hub the user only added for limits.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

export const ACCOUNT_HUB_SOURCE_ID = UsageLimitSourceId.make("signalbox-account-hub");

const HubUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const HubKey = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** Which hub pooled accounts go through. Keys never leave the server. */
export const AccountHubConnection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("managed") }),
  Schema.Struct({ mode: Schema.Literal("external"), url: HubUrl }),
]);
export type AccountHubConnection = typeof AccountHubConnection.Type;

export const AccountHubSetConnectionInput = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("managed") }),
  Schema.Struct({
    mode: Schema.Literal("external"),
    url: HubUrl,
    /** CLIProxyAPI's `management.secret-key`. */
    managementKey: HubKey,
    /** One of its `access.api-keys`, which the harnesses send. */
    clientKey: HubKey,
  }),
]);
export type AccountHubSetConnectionInput = typeof AccountHubSetConnectionInput.Type;

export const AccountHubImportInput = Schema.Struct({
  url: HubUrl,
  managementKey: HubKey,
  /**
   * Remove each account from the source once it is copied. Accounts refresh
   * rotating tokens, so two hubs holding the same account sign each other out.
   */
  removeFromSource: Schema.Boolean,
});
export type AccountHubImportInput = typeof AccountHubImportInput.Type;

export const AccountHubImportResult = Schema.Struct({
  imported: Schema.Array(Schema.String),
  /** Already in the hub under the same name. */
  skipped: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
});
export type AccountHubImportResult = typeof AccountHubImportResult.Type;

export class AccountHubRpcError extends Schema.TaggedError<AccountHubRpcError>()(
  "AccountHubRpcError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
