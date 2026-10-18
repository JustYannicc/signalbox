import * as Schema from "effect/Schema";

import { jsonCodec } from "./jsonCodec.ts";

// Kept independent from DriveProtocol so that DriveProtocol can publish these
// paths without introducing a protocol import cycle.
export const PULL_PATHS = {
  save: "/api/drive/pull/save",
  receipts: "/api/drive/pull/receipts",
} as const;

export const pullReceiptPath = (id: string) => `${PULL_PATHS.receipts}/${encodeURIComponent(id)}`;

const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** The exact local refs and drive revision on which a remote pull was based. */
export const PullOperation = Schema.Struct({
  id: Schema.String,
  target: Oid,
  expectedThread: Schema.NullOr(Oid),
  expectedWip: Schema.NullOr(Oid),
  revision: Schema.NullOr(Schema.String),
  branch: Schema.String,
});
export type PullOperation = typeof PullOperation.Type;

/** The result a Runner produced, retained verbatim by the drive on success. */
export const PullResult = Schema.Struct({
  id: Schema.String,
  target: Oid,
  head: Schema.NullOr(Oid),
  wip: Schema.NullOr(Oid),
  outcome: Schema.Literals(["pulled", "up_to_date", "refused"]),
  reason: Schema.NullOr(Schema.String),
  hasWorkingTreeChanges: Schema.Boolean,
});
export type PullResult = typeof PullResult.Type;

export const PullSaveRequest = Schema.Struct({
  operation: PullOperation,
  result: PullResult,
});
export type PullSaveRequest = typeof PullSaveRequest.Type;

export const pullJson = {
  save: jsonCodec(PullSaveRequest),
  result: jsonCodec(PullResult),
  receipt: jsonCodec(Schema.NullOr(PullResult)),
};
