import * as Schema from "effect/Schema";
import {
  CLAUDE_REQUEST_ATTEMPTS_KEY,
  CLAUDE_REQUEST_ATTEMPTS_PREFIX,
  claudeRequestAttemptKey,
} from "./qualification/fixture/claudeAttemptKeys.ts";
import {
  decodeClaudeRequestAttemptCounters,
  decodeClaudeRequestAttemptMarker,
  type ClaudeRequestAttemptCounters,
  type ClaudeRequestAttemptMarker,
} from "./qualification/fixture/claudeAttemptEvidence.ts";

export const EvidenceArtifact = Schema.Struct({
  id: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
});
export const EvidenceEntries = Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown]));
const Reservation = Schema.Struct({
  sequence: Schema.Number,
  kind: Schema.String,
  payloadHash: Schema.String,
});
const Record = Schema.Struct({
  sequence: Schema.Number,
  kind: Schema.String,
  payload: EvidenceArtifact,
});

const decodeEvidenceArtifact = Schema.decodeUnknownSync(EvidenceArtifact);
const decodeEvidenceEntries = Schema.decodeUnknownSync(EvidenceEntries);
const decodeReservation = Schema.decodeUnknownSync(Reservation);
const decodeRecord = Schema.decodeUnknownSync(Record);

function artifact(value: unknown) {
  const ref = decodeEvidenceArtifact(value);
  if (
    !ref.id ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0
  ) {
    throw new Error("Invalid evidence blob reference");
  }
  return ref;
}

/** A reserved journal append without its matching record is an incomplete export. */
export function inspectEvidenceInventory(input: unknown) {
  const entries = decodeEvidenceEntries(input);
  const blobs = new Map<string, typeof EvidenceArtifact.Type>();
  const reservations = new Map<number, typeof Reservation.Type>();
  const records = new Map<number, typeof Record.Type>();
  const claudeAttempts = new Map<number, ClaudeRequestAttemptMarker>();
  let claudeAttemptCounters: ClaudeRequestAttemptCounters | undefined;
  let previous = "";
  for (const [key, value] of entries) {
    if (key <= previous) throw new Error("Evidence keys repeated or changed order");
    previous = key;
    if (key.startsWith("blob/")) {
      const ref = artifact(value);
      if (key !== `blob/${ref.id}/ref` || blobs.has(ref.id))
        throw new Error("Evidence blob identity differs");
      blobs.set(ref.id, ref);
    } else if (key.startsWith("journal/reservation/") || key.startsWith("journal/record/")) {
      const reservation = key.startsWith("journal/reservation/");
      const row = reservation ? decodeReservation(value) : decodeRecord(value);
      if (
        !Number.isSafeInteger(row.sequence) ||
        row.sequence <= 0 ||
        key !==
          `journal/${reservation ? "reservation" : "record"}/${String(row.sequence).padStart(10, "0")}`
      ) {
        throw new Error("Evidence journal sequence differs");
      }
      if (reservation) reservations.set(row.sequence, decodeReservation(value));
      else records.set(row.sequence, decodeRecord(value));
    } else if (key === CLAUDE_REQUEST_ATTEMPTS_KEY) {
      claudeAttemptCounters = decodeClaudeRequestAttemptCounters(value);
    } else if (key.startsWith(CLAUDE_REQUEST_ATTEMPTS_PREFIX)) {
      const ordinal = Number(key.slice(CLAUDE_REQUEST_ATTEMPTS_PREFIX.length));
      if (
        !Number.isSafeInteger(ordinal) ||
        ordinal < 1 ||
        claudeRequestAttemptKey(ordinal) !== key
      ) {
        throw new Error("Claude request attempt key differs");
      }
      const attempt = decodeClaudeRequestAttemptMarker(value);
      if (attempt.ordinal !== ordinal) throw new Error("Claude request attempt identity differs");
      claudeAttempts.set(ordinal, attempt);
    } else throw new Error("Unknown evidence inventory entry");
  }
  if (claudeAttempts.size > 0 !== (claudeAttemptCounters !== undefined)) {
    throw new Error("Claude request-attempt counters do not match their markers");
  }
  if (claudeAttemptCounters) {
    let activeRequests = 0;
    let succeeded = 0;
    let failed = 0;
    const ordinals = [...claudeAttempts.keys()].sort((left, right) => left - right);
    if (ordinals.length !== claudeAttemptCounters.nextOrdinal) {
      throw new Error("Claude request-attempt inventory is incomplete");
    }
    for (const [index, ordinal] of ordinals.entries()) {
      if (ordinal !== index + 1) throw new Error("Claude request-attempt inventory is incomplete");
      const attempt = claudeAttempts.get(ordinal);
      if (!attempt) throw new Error("Claude request-attempt inventory is incomplete");
      if (attempt.state === "started") activeRequests++;
      else if (attempt.outcome === "success") succeeded++;
      else failed++;
    }
    if (
      activeRequests !== claudeAttemptCounters.activeRequests ||
      succeeded !== claudeAttemptCounters.succeeded ||
      failed !== claudeAttemptCounters.failed
    ) {
      throw new Error("Claude request-attempt counters do not match their markers");
    }
  }
  if (blobs.size === 0 || reservations.size === 0 || reservations.size !== records.size) {
    throw new Error("Evidence journal is empty or has unfinished reservations");
  }
  for (let sequence = 1; sequence <= reservations.size; sequence++) {
    const reserved = reservations.get(sequence);
    const recorded = records.get(sequence);
    const blob = recorded ? blobs.get(recorded.payload.id) : undefined;
    if (
      !reserved ||
      !recorded ||
      !blob ||
      reserved.kind !== recorded.kind ||
      reserved.payloadHash !== blob.sha256 ||
      recorded.payload.sha256 !== blob.sha256 ||
      recorded.payload.bytes !== blob.bytes
    ) {
      throw new Error("Evidence journal has a missing or mismatched payload");
    }
  }
  return [...blobs.values()];
}
