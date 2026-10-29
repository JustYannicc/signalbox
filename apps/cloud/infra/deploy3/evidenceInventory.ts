import * as Schema from "effect/Schema";

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
    } else throw new Error("Unknown evidence inventory entry");
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
