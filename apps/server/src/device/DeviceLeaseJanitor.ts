import { DeviceOperationError, type DeviceId, type DeviceHostId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  canonicalDeviceId,
  deviceAliases,
  deviceLeaseKey,
  leaseMatchesDevice,
  leaseIdleLongEnough,
  type DeviceLeaseRecord,
  type DeviceLeaseTarget,
} from "./DeviceLease.ts";
import type { DeviceLeaseAccess } from "./DeviceLeaseAccess.ts";
import type { DeviceLeaseShutdownClaim } from "./DeviceLeaseCoordinator.ts";

export interface DeviceJanitorItem {
  readonly hostId: string;
  readonly deviceId: string;
  readonly status: "would_shutdown" | "shutdown_pending" | "shutdown" | "skipped";
  readonly reason?:
    | "active_owner"
    | "unknown_owner"
    | "not_idle"
    | "not_signalbox_owned"
    | "physical"
    | "in_progress"
    | "waiting_walk"
    | "not_booted"
    | "unreadable_lease"
    | "not_found";
  readonly claim?: DeviceLeaseShutdownClaim;
}
type DeviceJanitorReason = NonNullable<DeviceJanitorItem["reason"]>;

export interface DeviceLeaseJanitor {
  readonly prepareExplicitShutdown: (input: {
    readonly target: DeviceLeaseTarget;
    readonly leaseId: string;
  }) => Effect.Effect<DeviceLeaseShutdownClaim, DeviceOperationError>;
  readonly planIdleCleanup: (input: {
    readonly now?: number;
    readonly hostId?: DeviceHostId;
    readonly deviceId?: DeviceId;
    readonly apply: boolean;
  }) => Effect.Effect<ReadonlyArray<DeviceJanitorItem>, DeviceOperationError>;
}

export const makeDeviceLeaseJanitor = (
  access: DeviceLeaseAccess,
  options: {
    readonly reconcileDevice?: (target: DeviceLeaseTarget) => Effect.Effect<boolean | undefined>;
  } = {},
): DeviceLeaseJanitor => {
  const { store, mapStoreError, withLocks, withoutDeadOwners, withoutDeadWaiters } = access;

  const prepareExplicitShutdown: DeviceLeaseJanitor["prepareExplicitShutdown"] = (input) =>
    withLocks(input.target, "shutdown", () =>
      Effect.gen(function* () {
        const entries = yield* access.entries;
        // A malformed record may contain the only AVD-name-to-serial mapping.
        // Refuse manual shutdown on that host because its device cannot be
        // matched safely from the remaining filename alone.
        const unknownOnHost = entries.some(
          (entry) =>
            entry.unknownReason !== undefined &&
            entry.key.split("\u0000", 2)[0] === input.target.hostId,
        );
        if (unknownOnHost) {
          return yield* new DeviceOperationError({
            operation: "shutdown",
            reason: "busy",
            cause: new Error("An unreadable lease on this host may own the device."),
          });
        }
        const matches = entries.flatMap((entry) =>
          entry.lease &&
          leaseMatchesDevice(entry.lease, {
            hostId: input.target.hostId,
            deviceId: input.target.id,
            aliases: deviceAliases(input.target),
          })
            ? [{ key: entry.key, lease: entry.lease }]
            : [],
        );
        if (matches.length > 1) {
          return yield* new DeviceOperationError({
            operation: "shutdown",
            reason: "busy",
            cause: new Error("Multiple leases match this device ID."),
          });
        }

        const match = matches[0];
        const key = match?.key ?? deviceLeaseKey(input.target);
        const current = yield* store
          .read(key)
          .pipe(Effect.mapError((cause) => mapStoreError("shutdown", cause)));
        if (
          current &&
          !leaseMatchesDevice(current, {
            hostId: input.target.hostId,
            deviceId: input.target.id,
            aliases: deviceAliases(input.target),
          })
        ) {
          return yield* new DeviceOperationError({
            operation: "shutdown",
            reason: "busy",
            cause: new Error("A device lease at this key does not match the requested device."),
          });
        }
        if (current && current.state !== "ready") {
          return yield* new DeviceOperationError({
            operation: "shutdown",
            reason: "busy",
            cause: new Error("A device operation is already in progress."),
          });
        }

        const now = yield* Clock.currentTimeMillis;
        if (current) {
          const ownership = yield* withoutDeadOwners(current, now);
          const waiterState = yield* withoutDeadWaiters(ownership.lease, now);
          if (ownership.owners.some((owner) => owner.status !== "dead")) {
            if (ownership.changed || waiterState.changed) {
              yield* store
                .write(key, waiterState.lease)
                .pipe(Effect.mapError((cause) => mapStoreError("shutdown", cause)));
            }
            return yield* new DeviceOperationError({
              operation: "shutdown",
              reason: "busy",
              cause: new Error("A live or unknown owner still holds this device."),
            });
          }
          if (waiterState.lease.waiters?.length) {
            if (ownership.changed || waiterState.changed) {
              yield* store
                .write(key, waiterState.lease)
                .pipe(Effect.mapError((cause) => mapStoreError("shutdown", cause)));
            }
            return yield* new DeviceOperationError({
              operation: "shutdown",
              reason: "busy",
              cause: new Error("Another walk is waiting for this device."),
            });
          }
          const pending: DeviceLeaseRecord = {
            ...waiterState.lease,
            state: "shutting_down",
            owners: [],
            shutdownOwner: {
              processId: access.processId,
              processIdentity: access.processIdentity,
            },
          };
          yield* store
            .write(key, pending)
            .pipe(Effect.mapError((cause) => mapStoreError("shutdown", cause)));
          const target = {
            hostId: current.hostId as DeviceHostId,
            platform: current.platform,
            id: current.deviceId,
            name: current.deviceName,
            booted: current.deviceBooted,
            physical: current.physical,
          } satisfies DeviceLeaseTarget;
          return { key, leaseId: current.leaseId, target };
        }

        const pending: DeviceLeaseRecord = {
          version: 1,
          leaseId: input.leaseId,
          state: "shutting_down",
          deviceBooted: input.target.booted,
          hostId: input.target.hostId,
          platform: input.target.platform,
          canonicalDeviceId: canonicalDeviceId(input.target),
          deviceId: input.target.id,
          aliases: [...new Set(deviceAliases(input.target))],
          deviceName: input.target.name,
          physical: input.target.physical,
          bootedBySignalbox: false,
          lastDeviceActivityAt: now,
          owners: [],
          shutdownOwner: {
            processId: access.processId,
            processIdentity: access.processIdentity,
          },
        };
        yield* store
          .write(key, pending)
          .pipe(Effect.mapError((cause) => mapStoreError("shutdown", cause)));
        return { key, leaseId: pending.leaseId, target: input.target };
      }),
    );

  const planIdleCleanup: DeviceLeaseJanitor["planIdleCleanup"] = (input) =>
    Effect.gen(function* () {
      const entries = yield* access.entries;
      const now = input.now ?? (yield* Clock.currentTimeMillis);
      const matchingEntries = entries.filter((entry) => {
        if (input.hostId === undefined && input.deviceId === undefined) return true;
        if (entry.lease) {
          return (
            (input.hostId === undefined || entry.lease.hostId === input.hostId) &&
            (input.deviceId === undefined ||
              leaseMatchesDevice(entry.lease, {
                hostId: entry.lease.hostId,
                deviceId: input.deviceId,
              }))
          );
        }
        const [hostId, deviceAlias] = entry.key.split("\u0000", 2);
        return (
          (input.hostId === undefined || hostId === input.hostId) &&
          (input.deviceId === undefined || deviceAlias === input.deviceId)
        );
      });
      const results: DeviceJanitorItem[] = [];
      for (const entry of matchingEntries) {
        if (!entry.lease) {
          results.push({
            hostId: input.hostId ?? "unknown",
            deviceId: input.deviceId ?? entry.key,
            status: "skipped",
            reason: "unreadable_lease",
          });
          continue;
        }
        const target = {
          hostId: entry.lease.hostId as DeviceHostId,
          platform: entry.lease.platform,
          id: entry.lease.deviceId,
          name: entry.lease.deviceName,
          booted: entry.lease.deviceBooted,
          physical: entry.lease.physical,
        } satisfies DeviceLeaseTarget;
        const item = yield* withLocks(target, "idle cleanup", () =>
          Effect.gen(function* () {
            let current = yield* store
              .read(entry.key)
              .pipe(Effect.mapError((cause) => mapStoreError("idle cleanup", cause)));
            if (!current) return undefined;
            const classify = (
              lease: DeviceLeaseRecord,
              reason: DeviceJanitorReason,
            ): DeviceJanitorItem => ({
              hostId: lease.hostId,
              deviceId: lease.deviceId,
              status: "skipped",
              reason,
            });
            if (current.physical) return classify(current, "physical");
            if (current.state === "shutting_down") {
              const claimant = current.shutdownOwner;
              if (
                claimant === undefined ||
                access.isOwnerProcessLive(claimant.processId, claimant.processIdentity) !==
                  "dead" ||
                options.reconcileDevice === undefined ||
                !input.apply
              )
                return classify(current, "in_progress");
              const reconciledBooted = yield* options.reconcileDevice(target);
              if (reconciledBooted === undefined) return classify(current, "in_progress");
              current = {
                ...current,
                state: "ready",
                deviceBooted: reconciledBooted,
                bootedBySignalbox: reconciledBooted && current.bootedBySignalbox,
                owners: [],
                shutdownOwner: undefined,
              };
              yield* store
                .write(entry.key, current)
                .pipe(Effect.mapError((cause) => mapStoreError("idle cleanup", cause)));
            }
            if (!current.bootedBySignalbox) return classify(current, "not_signalbox_owned");
            if (!current.deviceBooted) return classify(current, "not_booted");
            if (current.state !== "ready") return classify(current, "in_progress");
            const ownership = yield* withoutDeadOwners(current, now);
            const waiterState = yield* withoutDeadWaiters(ownership.lease, now);
            if (input.apply && (ownership.changed || waiterState.changed)) {
              yield* store
                .write(entry.key, waiterState.lease)
                .pipe(Effect.mapError((cause) => mapStoreError("idle cleanup", cause)));
            }
            if (ownership.owners.some((owner) => owner.status === "unknown")) {
              return classify(current, "unknown_owner");
            }
            if (ownership.owners.some((owner) => owner.status === "live")) {
              return classify(current, "active_owner");
            }
            if (waiterState.lease.waiters?.length) return classify(current, "waiting_walk");
            if (!leaseIdleLongEnough(waiterState.lease, now)) return classify(current, "not_idle");
            if (!input.apply) {
              return {
                hostId: current.hostId,
                deviceId: current.deviceId,
                status: "would_shutdown" as const,
              };
            }
            const pending = {
              ...waiterState.lease,
              state: "shutting_down" as const,
              owners: [],
              shutdownOwner: {
                processId: access.processId,
                processIdentity: access.processIdentity,
              },
            };
            yield* store
              .write(entry.key, pending)
              .pipe(Effect.mapError((cause) => mapStoreError("idle cleanup", cause)));
            return {
              hostId: current.hostId,
              deviceId: current.deviceId,
              status: "shutdown_pending" as const,
              claim: { key: entry.key, leaseId: pending.leaseId, target },
            };
          }),
        );
        if (item) results.push(item);
        // Return one durable shutdown claim at a time. The caller must finish
        // or roll it back before another device can enter shutting_down.
        if (item?.claim !== undefined) break;
      }
      return results;
    });

  return { prepareExplicitShutdown, planIdleCleanup };
};
