import * as Schema from "effect/Schema";
import { parseDeploy3Name } from "./deadline.ts";
import { DEPLOY3_LIFETIME_MS, DEPLOY3_TOKEN_GRACE_MS } from "./expiry.ts";
import { isoAt } from "./platform.ts";
import type { Deploy3Owner } from "./teardownReceipt.ts";

export const CONTROL_MARKER = "<!-- signalbox-deploy3-control-v1 -->\n";
const Owner = Schema.Literals(["1070", "1255"]);
const Registration = Schema.Struct({
  kind: Schema.Literal("registered"),
  runId: Schema.String,
  workerName: Schema.String,
  workerId: Schema.String,
  deployedAtUtc: Schema.String,
  deadlineUtc: Schema.String,
  namespaceIds: Schema.Array(Schema.String),
  tailIds: Schema.Array(Schema.String),
  cleanupTokenId: Schema.String,
  cleanupTokenExpiresOn: Schema.String,
  owners: Schema.Array(Schema.Struct({ owner: Owner, writerId: Schema.Number })),
});
const Release = Schema.Struct({
  kind: Schema.Literal("released"),
  runId: Schema.String,
  registrationSha256: Schema.String,
  owner: Owner,
  verifiedLocalExportSha256: Schema.String,
  explicitReleaseSha256: Schema.String,
});
const Extension = Schema.Struct({
  kind: Schema.Literal("extended"),
  runId: Schema.String,
  registrationSha256: Schema.String,
  deadlineUtc: Schema.String,
  cleanupTokenExpiresOn: Schema.String,
  coordinatorAuthoritySha256: Schema.String,
});
export type Deploy3ControlRegistration = typeof Registration.Type;
export type Deploy3ControlEvent =
  | Deploy3ControlRegistration
  | typeof Release.Type
  | typeof Extension.Type;
export interface Deploy3ControlComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly id: number };
}
export interface Deploy3RegisteredControl {
  readonly registration: Deploy3ControlRegistration;
  readonly registrationId: number;
  readonly registrationSha256: string;
  readonly controllerWriterId: number;
  readonly deadlineUtc: string;
  readonly cleanupTokenExpiresOn: string;
  readonly extensionAuthoritySha256?: string;
  readonly ownersNotReleased: readonly Deploy3Owner[];
}
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const id = (value: string) => /^[a-f0-9]{32}$/.test(value);
const resource = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
const writer = (value: number) => Number.isSafeInteger(value) && value > 0;

const decodeControlKind = Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.String }));
const decodeRegistration = Schema.decodeUnknownSync(Registration);
const decodeRelease = Schema.decodeUnknownSync(Release);
const decodeExtension = Schema.decodeUnknownSync(Extension);
const decodeControlJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

function utc(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || isoAt(milliseconds) !== value)
    throw new Error("Invalid control UTC");
  return milliseconds;
}

export async function controlDigest(body: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeControlEvent(value: unknown): Deploy3ControlEvent {
  const discriminator = decodeControlKind(value);
  if (discriminator.kind === "registered") {
    const registration = decodeRegistration(value);
    const parsed = parseDeploy3Name(registration.workerName);
    const deadline = utc(registration.deadlineUtc);
    if (
      !parsed ||
      parsed.role !== "workload" ||
      parsed.runId !== registration.runId ||
      deadline < parsed.deadlineMs ||
      deadline !== utc(registration.deployedAtUtc) + DEPLOY3_LIFETIME_MS ||
      !id(registration.workerId) ||
      !id(registration.cleanupTokenId) ||
      utc(registration.cleanupTokenExpiresOn) !== deadline + DEPLOY3_TOKEN_GRACE_MS ||
      registration.namespaceIds.some((value) => !resource(value)) ||
      registration.tailIds.some((value) => !resource(value)) ||
      registration.namespaceIds.length > 32 ||
      registration.tailIds.length > 32 ||
      new Set(registration.namespaceIds).size !== registration.namespaceIds.length ||
      new Set(registration.tailIds).size !== registration.tailIds.length ||
      registration.owners.length < 1 ||
      registration.owners.length > 2 ||
      !registration.owners.some((row) => row.owner === "1070") ||
      new Set(registration.owners.map((row) => row.owner)).size !== registration.owners.length ||
      registration.owners.some((row) => !writer(row.writerId))
    )
      throw new Error("Invalid deployment control identity");
    return registration;
  }
  if (discriminator.kind === "released") {
    const release = decodeRelease(value);
    if (
      !/^[a-f0-9]{8}$/.test(release.runId) ||
      !digest(release.registrationSha256) ||
      !digest(release.verifiedLocalExportSha256) ||
      !digest(release.explicitReleaseSha256)
    ) {
      throw new Error("Invalid owner release record");
    }
    return release;
  }
  const extension = decodeExtension(value);
  if (
    !/^[a-f0-9]{8}$/.test(extension.runId) ||
    !digest(extension.registrationSha256) ||
    !digest(extension.coordinatorAuthoritySha256) ||
    utc(extension.cleanupTokenExpiresOn) !== utc(extension.deadlineUtc) + DEPLOY3_TOKEN_GRACE_MS
  ) {
    throw new Error("Invalid written extension record");
  }
  return extension;
}

export function controlBody(value: unknown) {
  // Schema normalization strips anything outside the non-sensitive control fields.
  return CONTROL_MARKER + JSON.stringify(decodeControlEvent(value));
}

export async function deploy3RegistrationSha256(registration: Deploy3ControlRegistration) {
  const event = decodeControlEvent(registration);
  if (event.kind !== "registered") {
    throw new Error("Registration digest requires a registered control event");
  }
  return controlDigest(controlBody(event));
}

/** Append-only release records preserve independent owners when updates arrive concurrently. */
export async function reconcileDeploy3Controls(
  comments: readonly Deploy3ControlComment[],
  trustedWriterIds: readonly number[],
): Promise<readonly Deploy3RegisteredControl[]> {
  if (trustedWriterIds.length === 0 || trustedWriterIds.some((value) => !writer(value))) {
    throw new Error("No trusted control registry writer is bound");
  }
  const events: { comment: Deploy3ControlComment; value: Deploy3ControlEvent; sha256: string }[] =
    [];
  const seen = new Set<number>();
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    if (!trustedWriterIds.includes(comment.user.id) || !comment.body.startsWith(CONTROL_MARKER))
      continue;
    if (!writer(comment.id) || seen.has(comment.id) || comment.body.length > 16_384) {
      throw new Error("Duplicate or invalid control comment");
    }
    seen.add(comment.id);
    const json = decodeControlJson(comment.body.slice(CONTROL_MARKER.length));
    const value = decodeControlEvent(json);
    if (controlBody(value) !== comment.body) throw new Error("Noncanonical control record");
    events.push({ comment, value, sha256: await controlDigest(comment.body) });
  }
  const registrations = events.filter((event) => event.value.kind === "registered");
  const runs = new Set<string>();
  const states: Deploy3RegisteredControl[] = [];
  for (const base of registrations) {
    const registration = base.value;
    if (registration.kind !== "registered") continue;
    if (runs.has(registration.runId)) throw new Error("Conflicting deployment registrations");
    runs.add(registration.runId);
    let deadlineUtc = registration.deadlineUtc;
    let cleanupTokenExpiresOn = registration.cleanupTokenExpiresOn;
    let extensionAuthoritySha256: string | undefined;
    const released = new Map<Deploy3Owner, string>();
    for (const event of events) {
      const value = event.value;
      if (value.kind === "registered" || value.runId !== registration.runId) continue;
      if (value.registrationSha256 !== base.sha256 || event.comment.id <= base.comment.id) {
        throw new Error("Control event is bound to a different registration");
      }
      if (value.kind === "released") {
        const owner = registration.owners.find((row) => row.owner === value.owner);
        if (!owner || owner.writerId !== event.comment.user.id)
          throw new Error("Owner release writer differs");
        const prior = released.get(value.owner);
        if (prior && prior !== event.sha256) throw new Error("Conflicting owner release records");
        released.set(value.owner, event.sha256);
      } else {
        if (
          event.comment.user.id !== base.comment.user.id ||
          utc(value.deadlineUtc) <= utc(deadlineUtc)
        ) {
          throw new Error("Extension is not a later authorized control update");
        }
        deadlineUtc = value.deadlineUtc;
        cleanupTokenExpiresOn = value.cleanupTokenExpiresOn;
        extensionAuthoritySha256 = value.coordinatorAuthoritySha256;
      }
    }
    states.push({
      registration,
      registrationId: base.comment.id,
      registrationSha256: base.sha256,
      controllerWriterId: base.comment.user.id,
      ...(extensionAuthoritySha256 ? { extensionAuthoritySha256 } : {}),
      deadlineUtc,
      cleanupTokenExpiresOn,
      ownersNotReleased: registration.owners
        .filter((row) => !released.has(row.owner))
        .map((row) => row.owner),
    });
  }
  return states;
}
