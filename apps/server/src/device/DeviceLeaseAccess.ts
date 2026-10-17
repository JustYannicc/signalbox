import { DeviceOperationError, ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  deviceAliases,
  leaseMatchesDevice,
  ownerLiveness,
  DEVICE_LEASE_WAIT_TIMEOUT_MS,
  type DeviceLeaseRecord,
  type DeviceLeaseTarget,
  type DeviceOwnerLiveness,
} from "./DeviceLease.ts";
import {
  DeviceLeaseStoreError,
  type DeviceLeaseStore,
  type DeviceLeaseStoreEntry,
} from "./DeviceLeaseStore.ts";

const isDeviceLeaseStoreError = Schema.is(DeviceLeaseStoreError);

export interface DeviceLeaseAccessOptions {
  readonly store: DeviceLeaseStore;
  readonly processId: number;
  readonly processIdentity: string;
  readonly isOwnerProcessLive: (pid: number, identity: string) => DeviceOwnerLiveness;
  readonly isProviderSessionLive?: (sessionId: ProviderSessionId) => Effect.Effect<boolean | null>;
}

export interface DeviceLeaseAccess {
  readonly store: DeviceLeaseStore;
  readonly processId: number;
  readonly processIdentity: string;
  readonly mapStoreError: (operation: string, cause: DeviceLeaseStoreError) => DeviceOperationError;
  readonly withLocks: <A, E>(
    target: DeviceLeaseTarget,
    operation: string,
    use: () => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | DeviceOperationError>;
  readonly find: (
    target: DeviceLeaseTarget,
    operation: string,
  ) => Effect.Effect<
    { readonly key: string; readonly lease: DeviceLeaseRecord } | undefined,
    DeviceOperationError
  >;
  readonly assessOwners: (
    lease: DeviceLeaseRecord,
    now: number,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly owner: DeviceLeaseRecord["owners"][number];
      readonly status: DeviceOwnerLiveness;
    }>
  >;
  readonly withoutDeadOwners: (
    lease: DeviceLeaseRecord,
    now: number,
  ) => Effect.Effect<{
    readonly lease: DeviceLeaseRecord;
    readonly owners: ReadonlyArray<{
      readonly owner: DeviceLeaseRecord["owners"][number];
      readonly status: DeviceOwnerLiveness;
    }>;
    readonly changed: boolean;
  }>;
  readonly withoutDeadWaiters: (
    lease: DeviceLeaseRecord,
    now: number,
  ) => Effect.Effect<{
    readonly lease: DeviceLeaseRecord;
    readonly changed: boolean;
  }>;
  readonly entries: Effect.Effect<ReadonlyArray<DeviceLeaseStoreEntry>, DeviceOperationError>;
}

export const makeDeviceLeaseAccess = (options: DeviceLeaseAccessOptions): DeviceLeaseAccess => {
  const mapStoreError = (operation: string, cause: DeviceLeaseStoreError) =>
    new DeviceOperationError({
      operation,
      reason: cause.reason === "lock_timeout" ? "busy" : "request_failed",
      cause,
    });

  const lockKeys = (target: DeviceLeaseTarget) =>
    [
      ...new Set(deviceAliases(target).map((alias) => `${target.hostId}\u0000alias\u0000${alias}`)),
    ].sort();

  const withLocks = <A, E>(
    target: DeviceLeaseTarget,
    operation: string,
    use: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | DeviceOperationError> => {
    const keys = lockKeys(target);
    const lockAt = (index: number): Effect.Effect<A, E | DeviceOperationError> =>
      index === keys.length
        ? use()
        : options.store.withLock(keys[index]!, lockAt(index + 1)).pipe(
            Effect.catchIf(
              (cause): cause is DeviceLeaseStoreError => isDeviceLeaseStoreError(cause),
              (cause) => Effect.fail(mapStoreError(operation, cause)),
            ),
          );
    return lockAt(0);
  };

  const entryMatches = (entry: DeviceLeaseStoreEntry, target: DeviceLeaseTarget) => {
    if (entry.lease) {
      return leaseMatchesDevice(entry.lease, {
        hostId: target.hostId,
        deviceId: target.id,
        aliases: deviceAliases(target),
      });
    }
    const [hostId, alias] = entry.key.split("\u0000", 2);
    return hostId === target.hostId && alias !== undefined && deviceAliases(target).includes(alias);
  };

  const find: DeviceLeaseAccess["find"] = (target, operation) =>
    options.store.list.pipe(
      Effect.mapError((cause) => mapStoreError(operation, cause)),
      Effect.flatMap((entries) => {
        const matches = entries.filter((entry) => entryMatches(entry, target));
        if (matches.some((entry) => entry.unknownReason !== undefined)) {
          return Effect.fail(
            new DeviceOperationError({
              operation,
              reason: "busy",
              cause: new Error("An unreadable lease may own this device."),
            }),
          );
        }
        const leases = matches.flatMap((entry) =>
          entry.lease === undefined ? [] : [{ key: entry.key, lease: entry.lease }],
        );
        return leases.length > 1
          ? Effect.fail(
              new DeviceOperationError({
                operation,
                reason: "busy",
                cause: new Error("Multiple lease records match this device."),
              }),
            )
          : Effect.succeed(leases[0]);
      }),
    );

  const assessOwners: DeviceLeaseAccess["assessOwners"] = (lease, now) =>
    Effect.forEach(lease.owners, (owner) =>
      (owner.kind === "agent" &&
      owner.providerSessionId &&
      owner.processId === options.processId &&
      owner.processIdentity === options.processIdentity &&
      options.isProviderSessionLive
        ? options.isProviderSessionLive(ProviderSessionId.make(owner.providerSessionId))
        : Effect.succeed(null)
      ).pipe(
        Effect.map((providerLive) => ({
          owner,
          status: ownerLiveness(
            owner,
            now,
            options.processId,
            options.processIdentity,
            providerLive,
            options.isOwnerProcessLive(owner.processId, owner.processIdentity),
          ),
        })),
      ),
    );

  const withoutDeadOwners: DeviceLeaseAccess["withoutDeadOwners"] = (lease, now) =>
    assessOwners(lease, now).pipe(
      Effect.map((owners) => ({
        lease: {
          ...lease,
          owners: owners.filter((entry) => entry.status !== "dead").map((entry) => entry.owner),
        },
        owners,
        changed: owners.some((entry) => entry.status === "dead"),
      })),
    );

  const withoutDeadWaiters: DeviceLeaseAccess["withoutDeadWaiters"] = (lease, now) =>
    Effect.forEach(lease.waiters ?? [], (waiter) =>
      (waiter.kind === "agent" &&
      waiter.providerSessionId &&
      waiter.processId === options.processId &&
      waiter.processIdentity === options.processIdentity &&
      options.isProviderSessionLive
        ? options.isProviderSessionLive(ProviderSessionId.make(waiter.providerSessionId))
        : Effect.succeed(null)
      ).pipe(
        Effect.map((providerLive) => ({
          waiter,
          status:
            providerLive === false
              ? ("dead" as const)
              : options.isOwnerProcessLive(waiter.processId, waiter.processIdentity),
        })),
      ),
    ).pipe(
      Effect.map((waiters) => {
        const remaining = waiters
          .filter(
            (entry) =>
              entry.status !== "dead" && entry.waiter.queuedAt > now - DEVICE_LEASE_WAIT_TIMEOUT_MS,
          )
          .map((entry) => entry.waiter);
        return {
          lease: { ...lease, ...(lease.waiters === undefined ? {} : { waiters: remaining }) },
          changed: waiters.some((entry) => entry.status === "dead"),
        };
      }),
    );

  return {
    store: options.store,
    processId: options.processId,
    processIdentity: options.processIdentity,
    mapStoreError,
    withLocks,
    find,
    assessOwners,
    withoutDeadOwners,
    withoutDeadWaiters,
    entries: options.store.list.pipe(
      Effect.mapError((cause) => mapStoreError("list leases", cause)),
    ),
  };
};
