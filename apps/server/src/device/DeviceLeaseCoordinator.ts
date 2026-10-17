import {
  DeviceOperationError,
  type DeviceSession,
  type DeviceId,
  type DeviceHostId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import type { DeviceLeaseAccess } from "./DeviceLeaseAccess.ts";

import {
  canonicalDeviceId,
  deviceAliases,
  deviceLeaseKey,
  sameWalk,
  type DeviceLeaseOwner,
  type DeviceLeaseRecord,
  type DeviceLeaseTarget,
} from "./DeviceLease.ts";

export interface DeviceLeaseCaller {
  readonly kind: "panel" | "agent";
  readonly threadId: ThreadId;
  readonly providerSessionId?: ProviderSessionId;
  readonly sessionId?: string;
  readonly leaseId?: string;
}

export interface DeviceLeaseAcquireRequest {
  readonly target: DeviceLeaseTarget;
  readonly caller: DeviceLeaseCaller;
  readonly shouldBoot: boolean;
  readonly waiterId: string;
}

export interface DeviceLeaseSession extends DeviceSession {
  readonly leaseKey: string;
}

export type DeviceLeaseAcquireResult =
  | { readonly _tag: "Waiting" }
  | {
      readonly _tag: "Acquired";
      readonly session: DeviceLeaseSession;
      readonly shouldBoot: boolean;
      readonly created: boolean;
    };

export interface DeviceLeaseShutdownClaim {
  readonly key: string;
  readonly leaseId: string;
  readonly target: DeviceLeaseTarget;
}

export interface DeviceLeaseCoordinator {
  readonly acquire: (
    request: DeviceLeaseAcquireRequest,
  ) => Effect.Effect<DeviceLeaseAcquireResult, DeviceOperationError>;
  readonly finishOpen: (input: {
    readonly key: string;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly target: DeviceLeaseTarget;
  }) => Effect.Effect<DeviceLeaseSession, DeviceOperationError>;
  readonly abortOpen: (input: {
    readonly key: string;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly target?: DeviceLeaseTarget;
  }) => Effect.Effect<DeviceLeaseShutdownClaim | undefined, DeviceOperationError>;
  readonly cancelWaiter: (input: {
    readonly target: DeviceLeaseTarget;
    readonly waiterId: string;
  }) => Effect.Effect<void, DeviceOperationError>;
  readonly release: (input: {
    readonly hostId?: DeviceHostId;
    readonly deviceId?: DeviceId;
    readonly threadId: ThreadId;
    readonly sessionId?: string;
    readonly leaseId?: string;
    readonly caller?: DeviceLeaseCaller;
    readonly shutdown?: boolean;
  }) => Effect.Effect<ReadonlyArray<DeviceLeaseShutdownClaim>, DeviceOperationError>;
  readonly finishShutdown: (
    claim: DeviceLeaseShutdownClaim,
    succeeded: boolean,
  ) => Effect.Effect<void, DeviceOperationError>;
}

const ownerKey = (owner: DeviceLeaseOwner) => `${owner.sessionId}\u0000${owner.leaseId}`;

export const makeDeviceLeaseCoordinator = (options: { readonly access: DeviceLeaseAccess }) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const { store, mapStoreError, withLocks, find, withoutDeadOwners, withoutDeadWaiters } =
      options.access;

    const sessionFor = (
      lease: DeviceLeaseRecord,
      owner: DeviceLeaseOwner,
      key: string,
    ): DeviceLeaseSession => ({
      sessionId: owner.sessionId,
      leaseId: lease.leaseId,
      ownerKind: owner.kind,
      ...(owner.kind === "panel" ? { observer: owner.observer === true } : {}),
      ...(owner.providerSessionId === undefined
        ? {}
        : { providerSessionId: owner.providerSessionId as ProviderSessionId }),
      threadId: owner.threadId as ThreadId,
      hostId: lease.hostId as DeviceHostId,
      deviceId: lease.deviceId as DeviceId,
      platform: lease.platform,
      openedAt: owner.openedAt,
      leaseKey: key,
    });

    const newOwner = (
      request: DeviceLeaseAcquireRequest,
      sessionId: string,
      leaseId: string,
      now: number,
      observer = false,
    ): DeviceLeaseOwner => ({
      sessionId,
      leaseId,
      threadId: request.caller.threadId,
      kind: request.caller.kind,
      ...(request.caller.kind === "panel" && observer ? { observer: true } : {}),
      ...(request.caller.kind === "agent" && request.caller.providerSessionId !== undefined
        ? { providerSessionId: request.caller.providerSessionId }
        : {}),
      processId: options.access.processId,
      processIdentity: options.access.processIdentity,
      openedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      lastActivityAt: now,
      lastHeartbeatAt: now,
    });

    const randomId = () =>
      crypto.randomUUIDv4().pipe(
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "open",
              reason: "request_failed",
              cause,
            }),
        ),
        Effect.map(String),
      );

    const acquire: DeviceLeaseCoordinator["acquire"] = (request) =>
      withLocks(request.target, "open", () =>
        Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const stored = yield* find(request.target, "open");
            const ownership = stored
              ? yield* withoutDeadOwners(stored.lease, now)
              : { lease: undefined, owners: [], changed: false };
            const waiterState = ownership.lease
              ? yield* withoutDeadWaiters(ownership.lease, now)
              : { lease: undefined, changed: false };
            const lease = waiterState.lease;
            if (stored && (ownership.changed || waiterState.changed)) {
              yield* store
                .write(stored.key, lease)
                .pipe(Effect.mapError((cause) => mapStoreError("open", cause)));
            }
            const queue = lease?.waiters ?? [];
            const existingWaiter = queue.find((waiter) => waiter.waiterId === request.waiterId);
            const enqueue = (current: DeviceLeaseRecord) => {
              if (existingWaiter) return current;
              const queuedAt = Math.max(now, ...queue.map((waiter) => waiter.queuedAt + 1));
              return {
                ...current,
                waiters: [
                  ...queue,
                  {
                    waiterId: request.waiterId,
                    threadId: request.caller.threadId,
                    kind: request.caller.kind,
                    ...(request.caller.kind === "agent" &&
                    request.caller.providerSessionId !== undefined
                      ? { providerSessionId: request.caller.providerSessionId }
                      : {}),
                    processId: options.access.processId,
                    processIdentity: options.access.processIdentity,
                    queuedAt,
                  },
                ],
              };
            };
            const wait = (current: DeviceLeaseRecord | undefined) =>
              current === undefined || stored === undefined
                ? Effect.succeed({ _tag: "Waiting" as const })
                : store.write(stored.key, enqueue(current)).pipe(
                    Effect.mapError((cause) => mapStoreError("open", cause)),
                    Effect.as({ _tag: "Waiting" as const }),
                  );

            if (lease?.state === "shutting_down") return yield* wait(lease);

            const requestHasExactPanelOwner =
              request.caller.kind === "panel" &&
              (request.caller.sessionId !== undefined || request.caller.leaseId !== undefined);
            if (
              requestHasExactPanelOwner &&
              (request.caller.sessionId === undefined || request.caller.leaseId === undefined)
            ) {
              return yield* new DeviceOperationError({
                operation: "open",
                reason: "stale_session",
                cause: new Error("Both sessionId and leaseId are required to renew a panel owner."),
              });
            }

            const exactOwner = requestHasExactPanelOwner
              ? lease?.owners.find(
                  (owner) =>
                    owner.kind === "panel" &&
                    owner.threadId === request.caller.threadId &&
                    owner.sessionId === request.caller.sessionId &&
                    owner.leaseId === request.caller.leaseId,
                )
              : undefined;
            if (requestHasExactPanelOwner && exactOwner === undefined) {
              return yield* new DeviceOperationError({
                operation: "open",
                reason: "stale_session",
                cause: new Error("The panel lease is no longer active."),
              });
            }

            const idempotentOwner = lease?.owners.find((owner) =>
              request.caller.kind === "agent"
                ? owner.kind === "agent" &&
                  owner.threadId === request.caller.threadId &&
                  owner.providerSessionId === request.caller.providerSessionId
                : requestHasExactPanelOwner &&
                  owner.sessionId === request.caller.sessionId &&
                  owner.leaseId === request.caller.leaseId,
            );
            if (lease && idempotentOwner) {
              if (lease.state === "opening") return { _tag: "Waiting" as const };
              const observer =
                idempotentOwner.kind === "panel" &&
                ownership.owners.some(
                  (entry) =>
                    entry.status !== "dead" &&
                    entry.owner.threadId === idempotentOwner.threadId &&
                    (entry.owner.kind === "agent" ||
                      (entry.owner.kind === "panel" &&
                        ownerKey(entry.owner) !== ownerKey(idempotentOwner) &&
                        entry.owner.observer !== true)),
                );
              const renewed = {
                ...idempotentOwner,
                ...(idempotentOwner.kind === "panel" ? { observer } : {}),
                lastActivityAt: now,
                lastHeartbeatAt: now,
              };
              const next = {
                ...lease,
                lastDeviceActivityAt: now,
                waiters: lease.waiters?.filter((waiter) => waiter.waiterId !== request.waiterId),
                owners: lease.owners.map((owner) =>
                  ownerKey(owner) === ownerKey(idempotentOwner) ? renewed : owner,
                ),
              };
              yield* store
                .write(stored!.key, next)
                .pipe(Effect.mapError((cause) => mapStoreError("open", cause)));
              return {
                _tag: "Acquired" as const,
                session: sessionFor(next, renewed, stored!.key),
                shouldBoot: false,
                created: false,
              };
            }

            const active = ownership.owners.filter((entry) => entry.status !== "dead");
            const sameWalkOwners = active.filter((entry) => sameWalk(entry.owner, request.caller));
            const hasConflict = active.some((entry) => !sameWalk(entry.owner, request.caller));
            const sameWalkLeaseIds = new Set(sameWalkOwners.map((entry) => entry.owner.leaseId));
            if (hasConflict || sameWalkLeaseIds.size > 1) return yield* wait(lease);
            if (lease?.state === "opening" && active.length > 0) {
              return { _tag: "Waiting" as const };
            }
            const queueHead = queue[0];
            if (
              sameWalkOwners.length === 0 &&
              queueHead !== undefined &&
              queueHead.waiterId !== request.waiterId
            )
              return yield* wait(lease);

            const inheritedOwner = sameWalkOwners[0]?.owner;
            const leaseId = inheritedOwner?.leaseId ?? (yield* randomId());
            const sessionId = yield* randomId();
            const recoveringOpening = lease?.state === "opening" && active.length === 0;
            const observer =
              request.caller.kind === "panel" &&
              sameWalkOwners.some(
                (entry) =>
                  entry.owner.kind === "agent" ||
                  (entry.owner.kind === "panel" && entry.owner.observer !== true),
              );
            const owner = newOwner(request, sessionId, leaseId, now, observer);
            const shouldBoot =
              request.shouldBoot &&
              (recoveringOpening || lease === undefined
                ? !request.target.booted
                : lease.deviceBooted !== true);
            const nextLease: DeviceLeaseRecord = {
              version: 1,
              leaseId,
              state: shouldBoot ? "opening" : "ready",
              deviceBooted: recoveringOpening
                ? request.target.booted
                : shouldBoot
                  ? false
                  : (lease?.deviceBooted ?? request.target.booted),
              hostId: request.target.hostId,
              platform: request.target.platform,
              canonicalDeviceId: canonicalDeviceId(request.target),
              deviceId: request.target.id,
              aliases: [...new Set([...(lease?.aliases ?? []), ...deviceAliases(request.target)])],
              deviceName: request.target.name,
              physical: request.target.physical,
              bootedBySignalbox: (lease?.bootedBySignalbox ?? false) || shouldBoot,
              lastDeviceActivityAt: now,
              owners: [
                ...(lease?.owners ?? []).map((existing) =>
                  request.caller.kind === "agent" &&
                  existing.kind === "panel" &&
                  existing.threadId === request.caller.threadId
                    ? { ...existing, observer: true }
                    : existing,
                ),
                owner,
              ],
              ...(queue.length === 0
                ? {}
                : { waiters: queue.filter((waiter) => waiter.waiterId !== request.waiterId) }),
            };
            const key = stored?.key ?? deviceLeaseKey(request.target);
            yield* store
              .write(key, nextLease)
              .pipe(Effect.mapError((cause) => mapStoreError("open", cause)));
            return {
              _tag: "Acquired" as const,
              session: sessionFor(nextLease, owner, key),
              shouldBoot,
              created: true,
            };
          }),
        ),
      );

    const finishOpen: DeviceLeaseCoordinator["finishOpen"] = (input) =>
      withLocks(input.target, "open", () =>
        Effect.gen(function* () {
          const lease = yield* store
            .read(input.key)
            .pipe(Effect.mapError((cause) => mapStoreError("open", cause)));
          if (!lease) {
            return yield* new DeviceOperationError({
              operation: "open",
              reason: "stale_session",
              cause: new Error("The provisional device lease disappeared."),
            });
          }
          const owner = lease.owners.find(
            (candidate) =>
              candidate.sessionId === input.sessionId && candidate.leaseId === input.leaseId,
          );
          if (!owner || lease.leaseId !== input.leaseId) {
            return yield* new DeviceOperationError({
              operation: "open",
              reason: "stale_session",
              cause: new Error("The provisional device owner disappeared."),
            });
          }
          const now = yield* Clock.currentTimeMillis;
          const readyLease: DeviceLeaseRecord = {
            ...lease,
            state: "ready",
            deviceBooted: true,
            canonicalDeviceId: canonicalDeviceId(input.target),
            deviceId: input.target.id,
            aliases: [...new Set([...lease.aliases, ...deviceAliases(input.target)])],
            deviceName: input.target.name,
            physical: input.target.physical,
            lastDeviceActivityAt: now,
            owners: lease.owners.map((candidate) =>
              ownerKey(candidate) === ownerKey(owner)
                ? { ...candidate, lastActivityAt: now, lastHeartbeatAt: now }
                : candidate,
            ),
          };
          yield* store
            .write(input.key, readyLease)
            .pipe(Effect.mapError((cause) => mapStoreError("open", cause)));
          return sessionFor(
            readyLease,
            readyLease.owners.find((candidate) => ownerKey(candidate) === ownerKey(owner))!,
            input.key,
          );
        }),
      );

    const abortOpen: DeviceLeaseCoordinator["abortOpen"] = (input) =>
      Effect.gen(function* () {
        const entries = yield* store.list.pipe(
          Effect.mapError((cause) => mapStoreError("open", cause)),
        );
        const entry = entries.find((candidate) => candidate.key === input.key && candidate.lease);
        if (!entry?.lease) return undefined;
        const target =
          input.target ??
          ({
            hostId: entry.lease.hostId as DeviceHostId,
            platform: entry.lease.platform,
            id: entry.lease.deviceId,
            name: entry.lease.deviceName,
            booted: entry.lease.deviceBooted,
            physical: entry.lease.physical,
          } satisfies DeviceLeaseTarget);
        return yield* withLocks(target, "open", () =>
          Effect.gen(function* () {
            const current = yield* store.read(input.key);
            if (!current || current.leaseId !== input.leaseId) return undefined;
            const owners = current.owners.filter(
              (owner) => owner.sessionId !== input.sessionId || owner.leaseId !== input.leaseId,
            );
            if (owners.length === current.owners.length) return undefined;
            if (owners.length > 0) {
              yield* store.write(input.key, { ...current, owners });
              return undefined;
            }
            if (!current.bootedBySignalbox) {
              yield* store.write(input.key, { ...current, state: "ready", owners: [] });
              return undefined;
            }
            const pending = {
              ...current,
              state: "shutting_down" as const,
              owners: [],
              shutdownOwner: {
                processId: options.access.processId,
                processIdentity: options.access.processIdentity,
              },
            };
            yield* store.write(input.key, pending);
            return { key: input.key, leaseId: input.leaseId, target };
          }).pipe(Effect.mapError((cause) => mapStoreError("open", cause))),
        );
      });

    const cancelWaiter: DeviceLeaseCoordinator["cancelWaiter"] = (input) =>
      withLocks(input.target, "open", () =>
        Effect.gen(function* () {
          const stored = yield* find(input.target, "open");
          if (!stored?.lease.waiters?.some((waiter) => waiter.waiterId === input.waiterId)) return;
          yield* store
            .write(stored.key, {
              ...stored.lease,
              waiters: stored.lease.waiters.filter((waiter) => waiter.waiterId !== input.waiterId),
            })
            .pipe(Effect.mapError((cause) => mapStoreError("open", cause)));
        }),
      );

    const release: DeviceLeaseCoordinator["release"] = (input) =>
      Effect.gen(function* () {
        const entries = yield* store.list.pipe(
          Effect.mapError((cause) => mapStoreError("close", cause)),
        );
        const candidates = entries.flatMap((entry) => {
          const lease = entry.lease;
          if (!lease) return [];
          if (input.hostId !== undefined && lease.hostId !== input.hostId) return [];
          if (
            input.deviceId !== undefined &&
            lease.deviceId !== input.deviceId &&
            !lease.aliases.includes(input.deviceId)
          )
            return [];
          const matches = lease.owners.some((owner) =>
            input.sessionId !== undefined
              ? owner.sessionId === input.sessionId &&
                owner.leaseId === input.leaseId &&
                owner.threadId === input.threadId &&
                owner.kind === (input.caller?.kind ?? "panel") &&
                (input.caller === undefined ||
                  owner.providerSessionId === input.caller.providerSessionId)
              : owner.threadId === input.threadId &&
                (input.caller?.kind ?? "panel") === owner.kind &&
                (input.caller === undefined ||
                  owner.providerSessionId === input.caller.providerSessionId),
          );
          return matches ? [{ key: entry.key, lease }] : [];
        });
        const claims: DeviceLeaseShutdownClaim[] = [];
        for (const candidate of candidates) {
          const target = {
            hostId: candidate.lease.hostId as DeviceHostId,
            platform: candidate.lease.platform,
            id: candidate.lease.deviceId,
            name: candidate.lease.deviceName,
            booted: candidate.lease.deviceBooted,
            physical: candidate.lease.physical,
          } satisfies DeviceLeaseTarget;
          const claim = yield* withLocks(target, "close", () =>
            Effect.gen(function* () {
              const current = yield* store
                .read(candidate.key)
                .pipe(Effect.mapError((cause) => mapStoreError("close", cause)));
              if (!current) return undefined;
              const now = yield* Clock.currentTimeMillis;
              const ownership = yield* withoutDeadOwners(current, now);
              const waiterState = yield* withoutDeadWaiters(ownership.lease, now);
              const closing = ownership.lease.owners.filter((owner) =>
                input.sessionId !== undefined
                  ? owner.sessionId === input.sessionId &&
                    owner.leaseId === input.leaseId &&
                    owner.threadId === input.threadId &&
                    owner.kind === (input.caller?.kind ?? "panel") &&
                    (input.caller === undefined ||
                      owner.providerSessionId === input.caller.providerSessionId)
                  : owner.threadId === input.threadId &&
                    (input.caller?.kind ?? "panel") === owner.kind &&
                    (input.caller === undefined ||
                      owner.providerSessionId === input.caller.providerSessionId),
              );
              if (closing.length === 0) return undefined;
              const remaining = waiterState.lease.owners.filter(
                (owner) => !closing.some((closed) => ownerKey(closed) === ownerKey(owner)),
              );
              if (input.shutdown && (remaining.length > 0 || waiterState.lease.waiters?.length)) {
                return yield* new DeviceOperationError({
                  operation: "close",
                  reason: "busy",
                  cause: new Error("Another owner or queued walk still depends on this device."),
                });
              }
              const nextLease = { ...waiterState.lease, owners: remaining };
              if (remaining.length === 0 && waiterState.lease.waiters?.length) {
                yield* store
                  .write(candidate.key, { ...nextLease, state: "ready" })
                  .pipe(Effect.mapError((cause) => mapStoreError("close", cause)));
                return undefined;
              }
              if (
                remaining.length === 0 &&
                waiterState.lease.deviceBooted &&
                (waiterState.lease.bootedBySignalbox || input.shutdown)
              ) {
                const pending: DeviceLeaseRecord = {
                  ...nextLease,
                  state: "shutting_down",
                  owners: [],
                  shutdownOwner: {
                    processId: options.access.processId,
                    processIdentity: options.access.processIdentity,
                  },
                };
                yield* store
                  .write(candidate.key, pending)
                  .pipe(Effect.mapError((cause) => mapStoreError("close", cause)));
                return {
                  key: candidate.key,
                  leaseId: ownership.lease.leaseId,
                  target,
                } satisfies DeviceLeaseShutdownClaim;
              }
              yield* store
                .write(candidate.key, {
                  ...nextLease,
                  state: "ready",
                  owners: remaining,
                  shutdownOwner: undefined,
                })
                .pipe(Effect.mapError((cause) => mapStoreError("close", cause)));
              return undefined;
            }),
          );
          if (claim) claims.push(claim);
        }
        return claims;
      });

    const finishShutdown: DeviceLeaseCoordinator["finishShutdown"] = (claim, succeeded) =>
      withLocks(claim.target, "shutdown", () =>
        Effect.gen(function* () {
          const current = yield* store.read(claim.key);
          if (!current || current.state !== "shutting_down" || current.leaseId !== claim.leaseId)
            return;
          if (succeeded) {
            yield* store.write(
              claim.key,
              current.waiters?.length
                ? {
                    ...current,
                    state: "ready",
                    deviceBooted: false,
                    bootedBySignalbox: false,
                    owners: [],
                    shutdownOwner: undefined,
                  }
                : undefined,
            );
          } else {
            yield* store.write(claim.key, {
              ...current,
              state: "ready",
              owners: [],
              shutdownOwner: undefined,
            });
          }
        }).pipe(Effect.mapError((cause) => mapStoreError("shutdown", cause))),
      );

    return {
      acquire,
      finishOpen,
      abortOpen,
      cancelWaiter,
      release,
      finishShutdown,
    } satisfies DeviceLeaseCoordinator;
  });
