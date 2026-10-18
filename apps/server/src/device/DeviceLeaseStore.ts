// @effect-diagnostics nodeBuiltinImport:off - Atomic mkdir and rename are the lease-store boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
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
  readonly token?: string | undefined;
}

const LockOwnerSchema = Schema.Struct({
  pid: Schema.Int,
  processIdentity: Schema.String,
  token: Schema.optional(Schema.String),
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

const isNotEmpty = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOTEMPTY";

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

export const makeFileDeviceLeaseStore = (
  rootDirectory: string,
  options: {
    readonly waitAttempts?: number;
    readonly waitInterval?: Duration.Input;
    readonly onDeadOwnerObserved?: () => Effect.Effect<void>;
    readonly onDeadOwnerGenerationVerified?: () => Effect.Effect<void>;
    readonly onDeadOwnerReapAttempted?: (moved: boolean) => Effect.Effect<void>;
  } = {},
): DeviceLeaseStore => {
  const recordPath = (key: string) => NodePath.join(rootDirectory, `${safeSegment(key)}.json`);
  const lockPath = (key: string, purpose = "operation") =>
    NodePath.join(rootDirectory, `${safeSegment(key)}.${purpose}.lock`);

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
    }).pipe(Effect.uninterruptible);

  const acquire = (
    key: string,
    path: string,
    remaining: number,
    reapDeadOwner: boolean,
  ): Effect.Effect<string, DeviceLeaseStoreError> => {
    const token = NodeCrypto.randomUUID();
    const ownerFile = (lock: string) => NodePath.join(lock, "owner.json");
    const boundedWait = (retry: () => Effect.Effect<string, DeviceLeaseStoreError>) =>
      remaining <= 1
        ? Effect.fail(
            new DeviceLeaseStoreError({
              key,
              reason: "lock_timeout",
              cause: new Error("Timed out waiting for the device operation lock."),
            }),
          )
        : Effect.sleep(options.waitInterval ?? DEVICE_LEASE_WAIT_INTERVAL).pipe(
            Effect.andThen(retry()),
          );
    const readLockOwner = (lock: string) =>
      Effect.tryPromise({
        try: async () => decodeLockOwner(await NodeFSP.readFile(ownerFile(lock), "utf8")),
        catch: (cause) => new DeviceLeaseStoreError({ key, reason: "read_failed", cause }),
      }).pipe(Effect.option);
    const acquireOnce = (lock: string, ownerToken: string) =>
      Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(rootDirectory, { recursive: true });
          await NodeFSP.mkdir(lock);
          try {
            await NodeFSP.writeFile(
              ownerFile(lock),
              encodeLockOwner({
                pid: NodeProcess.pid,
                processIdentity: currentDeviceLeaseProcessIdentity,
                token: ownerToken,
              } satisfies LockOwner),
              {
                encoding: "utf8",
                mode: 0o600,
              },
            );
          } catch (cause) {
            await NodeFSP.rm(lock, { recursive: true, force: true }).catch(() => undefined);
            throw cause;
          }
          return ownerToken;
        },
        catch: (cause) =>
          isExists(cause)
            ? new LockBusyError({ key, path: lock })
            : new DeviceLeaseStoreError({ key, reason: "write_failed", cause }),
      }).pipe(
        // Directory creation and its owner marker are one lock acquisition. An
        // interrupted Promise must not leave a markerless lock behind.
        Effect.uninterruptible,
      );
    return acquireOnce(path, token).pipe(
      Effect.catchTags({
        LockBusyError: () =>
          Effect.gen(function* () {
            const owner = Option.getOrUndefined(yield* readLockOwner(path));
            if (
              reapDeadOwner &&
              owner !== undefined &&
              owner.token !== undefined &&
              owner.token.length > 0 &&
              deviceLeaseProcessLiveness(owner.pid, owner.processIdentity) === "dead"
            ) {
              yield* options.onDeadOwnerObserved?.() ?? Effect.void;
              const current = Option.getOrUndefined(yield* readLockOwner(path));
              if (
                current !== undefined &&
                current.token === owner.token &&
                current.pid === owner.pid &&
                current.processIdentity === owner.processIdentity &&
                deviceLeaseProcessLiveness(current.pid, current.processIdentity) === "dead"
              ) {
                yield* options.onDeadOwnerGenerationVerified?.() ?? Effect.void;
                const expiredPath = `${path}.expired.${safeSegment(owner.token)}`;
                const moved = yield* Effect.tryPromise({
                  try: async () => {
                    try {
                      await NodeFSP.rename(path, expiredPath);
                      return true;
                    } catch (cause) {
                      if (isMissing(cause) || isExists(cause) || isNotEmpty(cause)) return false;
                      throw cause;
                    }
                  },
                  catch: (cause) =>
                    new DeviceLeaseStoreError({ key, reason: "write_failed", cause }),
                });
                yield* options.onDeadOwnerReapAttempted?.(moved) ?? Effect.void;
                if (moved) {
                  // Keep the generation tombstone: a contender paused after reading this dead
                  // owner must not be able to rename a replacement lock at the same path.
                  return yield* acquire(key, path, remaining - 1, reapDeadOwner);
                }
              }
            }
            return yield* boundedWait(() => acquire(key, path, remaining - 1, reapDeadOwner));
          }),
      }),
    );
  };

  const release = (path: string, token: string) =>
    Effect.tryPromise({
      try: async () => {
        let owner: LockOwner;
        try {
          owner = decodeLockOwner(await NodeFSP.readFile(ownerPathFor(path), "utf8"));
        } catch (cause) {
          if (isMissing(cause)) return;
          throw cause;
        }
        if (owner.token === token) await NodeFSP.rm(path, { recursive: true, force: true });
      },
      catch: (cause) => new DeviceLeaseStoreError({ key: path, reason: "write_failed", cause }),
    }).pipe(Effect.uninterruptible);

  const ownerPathFor = (path: string) => NodePath.join(path, "owner.json");

  return {
    withLock: (key, use) =>
      Effect.acquireUseRelease(
        acquire(key, lockPath(key), options.waitAttempts ?? DEVICE_LEASE_WAIT_ATTEMPTS, true),
        () => use,
        (token) => release(lockPath(key), token),
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
  path: Schema.String,
}) {}
