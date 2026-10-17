// @effect-diagnostics nodeBuiltinImport:off - Atomic mkdir and rename are the lease-store boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import {
  DEVICE_LEASE_WAIT_ATTEMPTS,
  DEVICE_LEASE_WAIT_INTERVAL,
  DeviceLeaseRecord,
  type DeviceLeaseRecord as DeviceLeaseRecordValue,
} from "./DeviceLease.ts";

export class DeviceLeaseStoreError extends Schema.TaggedError<DeviceLeaseStoreError>()(
  "DeviceLeaseStoreError",
  {
    key: Schema.String,
    reason: Schema.Literals(["read_failed", "write_failed", "invalid_record", "lock_timeout"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.reason === "lock_timeout") {
      return "The device is busy with another operation. Wait for it to finish or cancel this request.";
    }
    return "Device lease state could not be read or written safely.";
  }
}

export interface DeviceLeaseStoreEntry {
  readonly key: string;
  readonly lease?: DeviceLeaseRecordValue;
  readonly unknownReason?: string;
}

export interface DeviceLeaseStore {
  readonly withLock: <A, E>(
    key: string,
    use: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | DeviceLeaseStoreError>;
  readonly read: (
    key: string,
  ) => Effect.Effect<DeviceLeaseRecordValue | undefined, DeviceLeaseStoreError>;
  readonly write: (
    key: string,
    lease: DeviceLeaseRecordValue | undefined,
  ) => Effect.Effect<void, DeviceLeaseStoreError>;
  readonly list: Effect.Effect<ReadonlyArray<DeviceLeaseStoreEntry>, DeviceLeaseStoreError>;
}

export const makeMemoryDeviceLeaseStore = Effect.gen(function* () {
  const values = yield* Ref.make(new Map<string, DeviceLeaseRecordValue>());
  const locks = yield* KeyedLock.make<string>();

  return {
    withLock: (key, use) => locks.withLock(key, use),
    read: (key) => Ref.get(values).pipe(Effect.map((current) => current.get(key))),
    write: (key, lease) =>
      Ref.update(values, (current) => {
        const next = new Map(current);
        if (lease === undefined) next.delete(key);
        else next.set(key, lease);
        return next;
      }),
    list: Ref.get(values).pipe(
      Effect.map((current) =>
        [...current].map(([key, lease]) => ({ key, lease }) satisfies DeviceLeaseStoreEntry),
      ),
    ),
  } satisfies DeviceLeaseStore;
});

interface LockOwner {
  readonly pid: number;
  readonly processIdentity: string;
}

const LockOwnerSchema = Schema.Struct({
  pid: Schema.Int,
  processIdentity: Schema.String,
});
const LockOwnerJson = Schema.fromJsonString(LockOwnerSchema);
const DeviceLeaseJson = Schema.fromJsonString(DeviceLeaseRecord);
const encodeLockOwner = Schema.encodeSync(LockOwnerJson);
const decodeLockOwner = Schema.decodeSync(LockOwnerJson);
const encodeDeviceLease = Schema.encodeSync(DeviceLeaseJson);
const decodeDeviceLease = Schema.decodeSync(DeviceLeaseJson);
const isDeviceLeaseStoreError = Schema.is(DeviceLeaseStoreError);

const safeSegment = (key: string) => Buffer.from(key).toString("base64url");

/** Shared across Signalbox worktrees so one host cannot lease the same device twice. */
export const deviceLeaseDirectory = (homeDirectory: string): string =>
  NodePath.join(homeDirectory, ".signalbox", "device-leases");

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const isExists = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";

export const currentDeviceLeaseProcessId = NodeProcess.pid;

export const deviceLeaseProcessIdentity = (pid: number): string | undefined => {
  try {
    if (NodeProcess.platform === "linux") {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const startedAt = fields[19];
      return bootId && startedAt ? `${bootId}:${startedAt}` : undefined;
    }
    if (NodeProcess.platform === "darwin" || NodeProcess.platform === "freebsd") {
      return (
        NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 2_000,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...NodeProcess.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
        }).trim() || undefined
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const currentDeviceLeaseProcessIdentity =
  deviceLeaseProcessIdentity(currentDeviceLeaseProcessId) ??
  `unavailable:${NodeCrypto.randomUUID()}`;

export const deviceLeaseProcessLiveness = (
  pid: number,
  expectedIdentity: string,
): "live" | "dead" | "unknown" => {
  if (pid === currentDeviceLeaseProcessId) {
    if (expectedIdentity === currentDeviceLeaseProcessIdentity) return "live";
    if (
      expectedIdentity.startsWith("unavailable:") ||
      currentDeviceLeaseProcessIdentity.startsWith("unavailable:")
    )
      return "unknown";
    return "dead";
  }
  const actualIdentity = deviceLeaseProcessIdentity(pid);
  if (actualIdentity !== undefined && !expectedIdentity.startsWith("unavailable:")) {
    return actualIdentity === expectedIdentity ? "live" : "dead";
  }
  try {
    NodeProcess.kill(pid, 0);
    return "unknown";
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH"
      ? "dead"
      : "unknown";
  }
};

const decodeLease = (value: string, key: string): DeviceLeaseRecordValue => {
  try {
    return decodeDeviceLease(value);
  } catch (cause) {
    throw new DeviceLeaseStoreError({ key, reason: "invalid_record", cause });
  }
};

export const makeFileDeviceLeaseStore = (rootDirectory: string): DeviceLeaseStore => {
  const recordPath = (key: string) => NodePath.join(rootDirectory, `${safeSegment(key)}.json`);
  const lockPath = (key: string) => NodePath.join(rootDirectory, `${safeSegment(key)}.lock`);
  const ownerPath = (key: string) => NodePath.join(lockPath(key), "owner.json");

  const read = (
    key: string,
  ): Effect.Effect<DeviceLeaseRecordValue | undefined, DeviceLeaseStoreError> =>
    Effect.tryPromise({
      try: async () => {
        try {
          return decodeLease(await NodeFSP.readFile(recordPath(key), "utf8"), key);
        } catch (cause) {
          if (isMissing(cause)) return undefined;
          throw cause;
        }
      },
      catch: (cause) =>
        isDeviceLeaseStoreError(cause)
          ? cause
          : new DeviceLeaseStoreError({ key, reason: "read_failed", cause }),
    });

  const write: DeviceLeaseStore["write"] = (key, lease) =>
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(rootDirectory, { recursive: true });
        const target = recordPath(key);
        if (lease === undefined) {
          await NodeFSP.rm(target, { force: true });
          return;
        }
        const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
        await NodeFSP.writeFile(temporary, encodeDeviceLease(lease), {
          encoding: "utf8",
          mode: 0o600,
        });
        await NodeFSP.rename(temporary, target);
      },
      catch: (cause) => new DeviceLeaseStoreError({ key, reason: "write_failed", cause }),
    });

  const acquire = (key: string, remaining: number): Effect.Effect<void, DeviceLeaseStoreError> =>
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(rootDirectory, { recursive: true });
        await NodeFSP.mkdir(lockPath(key));
        try {
          await NodeFSP.writeFile(
            ownerPath(key),
            encodeLockOwner({
              pid: NodeProcess.pid,
              processIdentity: currentDeviceLeaseProcessIdentity,
            } satisfies LockOwner),
            {
              encoding: "utf8",
              mode: 0o600,
            },
          );
        } catch (cause) {
          await NodeFSP.rm(lockPath(key), { recursive: true, force: true }).catch(() => undefined);
          throw cause;
        }
      },
      catch: (cause) =>
        isExists(cause)
          ? new LockBusyError({ key })
          : new DeviceLeaseStoreError({ key, reason: "write_failed", cause }),
    }).pipe(
      // Directory creation and its owner marker are one lock acquisition. An
      // interrupted Promise must not leave a markerless lock behind.
      Effect.uninterruptible,
      Effect.catchTags({
        LockBusyError: () =>
          Effect.gen(function* () {
            const lockOwner = yield* Effect.tryPromise({
              try: async () => decodeLockOwner(await NodeFSP.readFile(ownerPath(key), "utf8")),
              catch: (cause) => new DeviceLeaseStoreError({ key, reason: "read_failed", cause }),
            }).pipe(Effect.option);
            const owner = Option.getOrUndefined(lockOwner);
            if (
              owner !== undefined &&
              Number.isInteger(owner.pid) &&
              typeof owner.processIdentity === "string" &&
              deviceLeaseProcessLiveness(owner.pid, owner.processIdentity) === "dead"
            ) {
              const expiredPath = `${lockPath(key)}.expired.${NodeCrypto.randomUUID()}`;
              yield* Effect.tryPromise({
                try: async () => {
                  await NodeFSP.rename(lockPath(key), expiredPath);
                  await NodeFSP.rm(expiredPath, { recursive: true, force: true });
                },
                catch: (cause) => new DeviceLeaseStoreError({ key, reason: "write_failed", cause }),
              }).pipe(
                Effect.catchIf(
                  (error) => isMissing(error.cause),
                  () => Effect.void,
                ),
              );
              return yield* acquire(key, remaining);
            }
            if (remaining <= 1) {
              return yield* new DeviceLeaseStoreError({
                key,
                reason: "lock_timeout",
                cause: new Error("Timed out waiting for the device operation lock."),
              });
            }
            yield* Effect.sleep(DEVICE_LEASE_WAIT_INTERVAL);
            return yield* acquire(key, remaining - 1);
          }),
      }),
    );

  return {
    withLock: (key, use) =>
      Effect.acquireUseRelease(
        acquire(key, DEVICE_LEASE_WAIT_ATTEMPTS),
        () => use,
        () =>
          Effect.tryPromise({
            try: () => NodeFSP.rm(lockPath(key), { recursive: true, force: true }),
            catch: (cause) => new DeviceLeaseStoreError({ key, reason: "write_failed", cause }),
          }),
      ),
    read,
    write,
    list: Effect.tryPromise({
      try: async () => {
        let files: NodeFS.Dirent[];
        try {
          files = await NodeFSP.readdir(rootDirectory, { withFileTypes: true });
        } catch (cause) {
          if (isMissing(cause)) return [];
          throw cause;
        }
        return await Promise.all(
          files
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map(async (entry) => {
              const encodedKey = entry.name.slice(0, -".json".length);
              const key = Buffer.from(encodedKey, "base64url").toString("utf8");
              try {
                const lease = decodeLease(
                  await NodeFSP.readFile(NodePath.join(rootDirectory, entry.name), "utf8"),
                  key,
                );
                return { key, lease } satisfies DeviceLeaseStoreEntry;
              } catch (cause) {
                return {
                  key,
                  unknownReason:
                    cause instanceof Error ? cause.message : "Lease record is unreadable.",
                } satisfies DeviceLeaseStoreEntry;
              }
            }),
        );
      },
      catch: (cause) =>
        new DeviceLeaseStoreError({ key: rootDirectory, reason: "read_failed", cause }),
    }),
  } satisfies DeviceLeaseStore;
};

class LockBusyError extends Schema.TaggedError<LockBusyError>()("LockBusyError", {
  key: Schema.String,
}) {}
