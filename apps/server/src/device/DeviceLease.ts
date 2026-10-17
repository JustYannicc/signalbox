import type { DeviceHostId, DevicePlatform } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const DEVICE_IDLE_TIMEOUT_MS = 30 * 60_000;
export const DEVICE_CLEANUP_INTERVAL = "5 minutes";
export const DEVICE_LEASE_WAIT_INTERVAL = "250 millis";
export const DEVICE_LEASE_WAIT_TIMEOUT_MS = 5 * 60_000;
export const DEVICE_LEASE_WAIT_INTERVAL_MS = 250;
export const DEVICE_LEASE_WAIT_ATTEMPTS =
  DEVICE_LEASE_WAIT_TIMEOUT_MS / DEVICE_LEASE_WAIT_INTERVAL_MS;
export const DEVICE_OWNER_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;
export const DEVICE_OWNER_HEARTBEAT_INTERVAL_MS = 60_000;

export const DeviceLeaseOwner = Schema.Struct({
  sessionId: Schema.String,
  leaseId: Schema.String,
  threadId: Schema.String,
  kind: Schema.Literals(["panel", "agent"]),
  observer: Schema.optional(Schema.Boolean),
  providerSessionId: Schema.optional(Schema.String),
  processId: Schema.Int,
  processIdentity: Schema.String,
  openedAt: Schema.String,
  lastActivityAt: Schema.Finite,
  lastHeartbeatAt: Schema.Finite,
});
export type DeviceLeaseOwner = typeof DeviceLeaseOwner.Type;

export const DeviceLeaseWaiter = Schema.Struct({
  waiterId: Schema.String,
  threadId: Schema.String,
  kind: Schema.Literals(["panel", "agent"]),
  providerSessionId: Schema.optional(Schema.String),
  processId: Schema.Int,
  processIdentity: Schema.String,
  queuedAt: Schema.Finite,
});
export type DeviceLeaseWaiter = typeof DeviceLeaseWaiter.Type;

export const DeviceLeaseShutdownOwner = Schema.Struct({
  processId: Schema.Int,
  processIdentity: Schema.String,
  claimId: Schema.optional(Schema.String),
});
export type DeviceLeaseShutdownOwner = typeof DeviceLeaseShutdownOwner.Type;

export const DeviceLeaseRecord = Schema.Struct({
  version: Schema.Literal(1),
  leaseId: Schema.String,
  state: Schema.Literals(["opening", "ready", "shutting_down"]),
  deviceBooted: Schema.Boolean,
  hostId: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  canonicalDeviceId: Schema.String,
  deviceId: Schema.String,
  aliases: Schema.Array(Schema.String),
  deviceName: Schema.String,
  physical: Schema.Boolean,
  bootedBySignalbox: Schema.Boolean,
  lastDeviceActivityAt: Schema.Finite,
  owners: Schema.Array(DeviceLeaseOwner),
  waiters: Schema.optional(Schema.Array(DeviceLeaseWaiter)),
  shutdownOwner: Schema.optional(DeviceLeaseShutdownOwner),
});
export type DeviceLeaseRecord = typeof DeviceLeaseRecord.Type;

export interface DeviceLeaseTarget {
  readonly hostId: DeviceHostId;
  readonly platform: DevicePlatform;
  readonly id: string;
  readonly name: string;
  readonly booted: boolean;
  readonly physical: boolean;
}

export const canonicalDeviceId = (device: DeviceLeaseTarget): string =>
  device.platform === "android" && !device.physical && device.name.length > 0
    ? `avd:${device.name}`
    : `${device.platform}:${device.id}`;

export const deviceAliases = (device: DeviceLeaseTarget): ReadonlyArray<string> => [
  device.id,
  canonicalDeviceId(device),
  ...(device.platform === "android" && !device.physical ? [device.name, `avd:${device.name}`] : []),
];

export const deviceLeaseKey = (device: DeviceLeaseTarget): string =>
  `${device.hostId}\u0000${canonicalDeviceId(device)}`;

export const leaseMatchesDevice = (
  lease: DeviceLeaseRecord,
  target: {
    readonly hostId: string;
    readonly deviceId: string;
    readonly aliases?: ReadonlyArray<string>;
  },
): boolean =>
  lease.hostId === target.hostId &&
  (lease.deviceId === target.deviceId ||
    lease.aliases.includes(target.deviceId) ||
    target.aliases?.some((alias) => lease.deviceId === alias || lease.aliases.includes(alias)) ===
      true);

export type DeviceOwnerLiveness = "live" | "dead" | "unknown";

export const ownerLiveness = (
  owner: DeviceLeaseOwner,
  now: number,
  currentProcessId: number,
  currentProcessIdentity: string,
  providerSessionLive: boolean | null,
  ownerProcessLive: DeviceOwnerLiveness,
): DeviceOwnerLiveness => {
  if (owner.kind === "agent" && providerSessionLive === true) return "live";
  if (owner.kind === "agent" && providerSessionLive === false) return "dead";
  if (ownerProcessLive === "dead") return "dead";
  if (owner.kind === "panel") {
    if (ownerProcessLive === "unknown") return "unknown";
    if (owner.processId === currentProcessId && owner.processIdentity !== currentProcessIdentity) {
      return "dead";
    }
    return now - owner.lastHeartbeatAt <= DEVICE_OWNER_HEARTBEAT_TIMEOUT_MS ? "live" : "unknown";
  }
  if (owner.processId === currentProcessId && owner.processIdentity !== currentProcessIdentity) {
    return "dead";
  }
  if (now - owner.lastHeartbeatAt <= DEVICE_OWNER_HEARTBEAT_TIMEOUT_MS) return "live";
  return "unknown";
};

export const sameWalk = (
  left: DeviceLeaseOwner,
  right: Pick<DeviceLeaseOwner, "kind" | "providerSessionId" | "threadId">,
): boolean =>
  left.providerSessionId !== undefined && right.providerSessionId !== undefined
    ? left.providerSessionId === right.providerSessionId
    : left.threadId === right.threadId &&
      ((left.kind === "panel" && right.kind === "panel") || left.kind !== right.kind);

export const leaseIdleLongEnough = (lease: DeviceLeaseRecord, now: number): boolean =>
  now - lease.lastDeviceActivityAt > DEVICE_IDLE_TIMEOUT_MS;
