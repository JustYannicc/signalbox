import { AccountSignInError } from "@t3tools/contracts/account";
import * as Schema from "effect/Schema";

const AccountOperation = Schema.Literals([
  "session",
  "handoff",
  "github-connect",
  "sign-out",
  "verify-email",
]);
export type AccountOperation = typeof AccountOperation.Type;

export const DEFAULT_ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;

export class AccountRequestFailedError extends Schema.TaggedError<AccountRequestFailedError>()(
  "AccountRequestFailedError",
  {
    operation: AccountOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.operation === "sign-out"
      ? "Couldn't sign out. Check your connection and try again."
      : `Account ${this.operation} request failed.`;
  }
}

export class AccountRequestTimeoutError extends Schema.TaggedError<AccountRequestTimeoutError>()(
  "AccountRequestTimeoutError",
  {
    operation: AccountOperation,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return this.operation === "sign-out"
      ? "Couldn't sign out. Check your connection and try again."
      : `Account ${this.operation} request timed out after ${this.timeoutMs}ms.`;
  }
}

export class AccountHttpStatusError extends Schema.TaggedError<AccountHttpStatusError>()(
  "AccountHttpStatusError",
  {
    operation: AccountOperation,
    status: Schema.Number,
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "github-connect":
        return `GitHub connection request failed (${this.status}).`;
      case "session":
        return `Account session request failed (${this.status}).`;
      case "sign-out":
        return "Couldn't sign out. Check your connection and try again.";
      default:
        return `Account ${this.operation} request failed (${this.status}).`;
    }
  }
}

export class AccountResponseDecodeError extends Schema.TaggedError<AccountResponseDecodeError>()(
  "AccountResponseDecodeError",
  {
    operation: AccountOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.operation === "github-connect"
      ? "Signalbox sent a connect link this app can't open."
      : `Account ${this.operation} returned an invalid response.`;
  }
}

export const isAccountRequestFailedError = Schema.is(AccountRequestFailedError);
export const isAccountRequestTimeoutError = Schema.is(AccountRequestTimeoutError);
export const isAccountHttpStatusError = Schema.is(AccountHttpStatusError);
export const isAccountResponseDecodeError = Schema.is(AccountResponseDecodeError);

/** A handoff the server refused, with the code to show the user. */
export class AccountHandoffError extends Schema.TaggedError<AccountHandoffError>()(
  "AccountHandoffError",
  { code: AccountSignInError },
) {
  override get message(): string {
    return `Sign-in handoff failed: ${this.code}.`;
  }
}

export const isAccountHandoffError = Schema.is(AccountHandoffError);

export type AccountClientError =
  | AccountRequestFailedError
  | AccountRequestTimeoutError
  | AccountHttpStatusError
  | AccountResponseDecodeError
  | AccountHandoffError;
