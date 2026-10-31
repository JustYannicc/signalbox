import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Schema from "effect/Schema";

const decodeActiveReservation = Schema.decodeUnknownSync(
  Schema.Struct({
    reservationState: Schema.Literal("RESERVED"),
    reservationId: Schema.String,
    currentOwnerThreadId: Schema.String,
    exclusiveHoldActive: Schema.Literal(true),
    reservedUntilRelease: Schema.Literal(true),
    expiresAt: Schema.Null,
  }),
  { reportInput: false },
);

function refuse(reason: string, cause?: unknown): never {
  throw new Error(
    `WORKERD_LAUNCH_REFUSED: ${reason}. Native builtin inventory requires a current RESERVED ACTIVE for the calling owner and batch.`,
    { cause },
  );
}

async function readActiveReservation(path: string) {
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    return decodeActiveReservation(value);
  } catch (cause) {
    return refuse(
      "ACTIVE is unreadable, invalid, or not exclusively RESERVED without expiry",
      cause,
    );
  }
}

export async function requireWorkerdLaunchAdmission() {
  const path = NodeProcess.env.SIGNALBOX_WORKERD_ACTIVE;
  const owner = NodeProcess.env.SIGNALBOX_WORKERD_OWNER;
  const batch = NodeProcess.env.SIGNALBOX_WORKERD_BATCH;
  if (!path?.trim() || !owner?.trim() || !batch?.trim()) {
    refuse(
      "Set SIGNALBOX_WORKERD_ACTIVE, SIGNALBOX_WORKERD_OWNER and SIGNALBOX_WORKERD_BATCH from the current ACK",
    );
  }
  if (!NodePath.isAbsolute(path) || NodePath.basename(path) !== "ACTIVE.json") {
    refuse("SIGNALBOX_WORKERD_ACTIVE must name the absolute live ACTIVE.json, not a saved ACK");
  }
  const active = await readActiveReservation(path);
  if (active.currentOwnerThreadId !== owner) {
    refuse(`ACTIVE owner ${active.currentOwnerThreadId} does not match caller ${owner}`);
  }
  if (active.reservationId !== batch) {
    refuse(`ACTIVE batch ${active.reservationId} does not match caller ${batch}`);
  }
}
