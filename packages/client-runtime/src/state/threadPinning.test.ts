import { describe, expect, it } from "@effect/vitest";
import { CommandId, type AuthSessionState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { managedRelaySessionAtom } from "../relay/managedRelayState.ts";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import {
  ENVIRONMENT_ID,
  makeHarness,
  NOW,
  SNAPSHOT,
  testConfigAtoms,
  testSessionAtoms,
  THREAD_ID,
} from "./threadCommandTestHarness.ts";

const target = { environmentId: ENVIRONMENT_ID, input: { threadId: THREAD_ID } };

describe("shared optimistic pin commands", () => {
  it.effect("shows a queued unpin immediately and preserves it when the older pin fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const entries = h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID);
      const pin = h.commands.pin.run(h.registry, target);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeDefined();
      expect(h.registry.get(h.snapshotAtom(ENVIRONMENT_ID))).toBe(SNAPSHOT);
      const first = yield* Queue.take(h.requests);
      const unpin = h.commands.unpin.run(h.registry, target);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeNull();
      expect(h.registry.get(entries).map((entry) => entry.status)).toEqual(["pending", "pending"]);
      expect(yield* Queue.size(h.requests)).toBe(0);
      yield* Deferred.fail(first.reply, new Error("Your access changed."));
      expect((yield* Effect.promise(() => pin))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeNull();
      expect(h.registry.get(entries)[0]).toMatchObject({ status: "rejected" });
      const second = yield* Queue.take(h.requests);
      expect(second.command.commandId).not.toBe(first.command.commandId);
      const confirmed = {
        ...SNAPSHOT,
        snapshotSequence: 3,
        threads: [{ ...SNAPSHOT.threads[0]!, pinnedAt: null, pinOrderKey: null }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      yield* Deferred.succeed(second.reply, { sequence: 3 });
      yield* Effect.promise(() => unpin);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      expect(h.registry.get(entries).map((entry) => entry.status)).toEqual(["rejected"]);
    }),
  );

  it.effect.each(["event-first", "ack-first"] as const)(
    "converges to the server-normalized pin with %s ordering",
    (order) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const commandId = CommandId.make("stable-pin");
        const result = h.commands.pin.run(h.registry, {
          ...target,
          input: { ...target.input, commandId, orderKey: "requested" },
        });
        const request = yield* Queue.take(h.requests);
        expect(request.command.commandId).toBe(commandId);
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 5,
          threads: [{ ...SNAPSHOT.threads[0]!, pinnedAt: NOW, pinOrderKey: "normalized" }],
        };
        const statuses = h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID);
        if (order === "event-first") {
          h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
          expect(h.registry.get(statuses)[0]?.status).toBe("pending");
        }
        yield* Deferred.succeed(request.reply, { sequence: 5 });
        yield* Effect.promise(() => result);
        if (order === "ack-first") {
          expect(h.registry.get(statuses)[0]?.status).toBe("confirming");
          expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinOrderKey).toBe("requested");
          h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        }
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
        expect(h.registry.get(statuses)).toEqual([]);
      }),
  );

  it.effect.each(["event-first", "ack-first"] as const)(
    "confirms cloud pin from its own summary revision with %s ordering",
    (order) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.registry.update(testConfigAtoms(ENVIRONMENT_ID), (config) => ({
          ...config,
          environment: {
            capabilities: { ...config.environment.capabilities, signalboxCloud: true },
          },
        }));
        const result = h.commands.pin.run(h.registry, target);
        const request = yield* Queue.take(h.requests);
        const entries = h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID);
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          snapshotSequence: 10_000,
          threads: [{ ...SNAPSHOT.threads[0]!, summaryRevision: 8 }],
        });
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 10_001,
          threads: [
            {
              ...SNAPSHOT.threads[0]!,
              pinnedAt: NOW,
              pinOrderKey: "normalized",
              summaryRevision: 12,
            },
          ],
        };
        if (order === "event-first") h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        yield* Deferred.succeed(request.reply, { sequence: 2, summaryRevision: 12 });
        yield* Effect.promise(() => result);
        if (order === "ack-first") {
          expect(h.registry.get(entries)[0]?.status).toBe("confirming");
          h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        }
        expect(h.registry.get(entries)).toEqual([]);
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
  );

  it.effect("rebases rapid cloud inverse actions until their own summary includes both", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.registry.update(testConfigAtoms(ENVIRONMENT_ID), (config) => ({
        ...config,
        environment: { capabilities: { ...config.environment.capabilities, signalboxCloud: true } },
      }));
      const pin = h.commands.pin.run(h.registry, target);
      const first = yield* Queue.take(h.requests);
      const unpin = h.commands.unpin.run(h.registry, target);
      yield* Deferred.succeed(first.reply, { sequence: 2, summaryRevision: 12 });
      yield* Effect.promise(() => pin);
      const second = yield* Queue.take(h.requests);
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        snapshotSequence: 10_000,
        threads: [{ ...SNAPSHOT.threads[0]!, pinnedAt: NOW, summaryRevision: 12 }],
      });
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeNull();
      yield* Deferred.succeed(second.reply, { sequence: 3, summaryRevision: 14 });
      yield* Effect.promise(() => unpin);
      const entries = h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID);
      expect(h.registry.get(entries).map((entry) => entry.status)).toEqual(["confirming"]);
      const confirmed = {
        ...SNAPSHOT,
        snapshotSequence: 10_001,
        threads: [{ ...SNAPSHOT.threads[0]!, pinnedAt: null, summaryRevision: 14 }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(entries)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
    }),
  );

  it.effect.each(["event-first", "ack-first"] as const)(
    "does not revive an older unknown unpin after a confirmed pin with %s ordering",
    (order) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          threads: [{ ...SNAPSHOT.threads[0]!, pinnedAt: NOW }],
        });
        const unpin = h.commands.unpin.run(h.registry, target);
        const first = yield* Queue.take(h.requests);
        yield* Deferred.fail(
          first.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* Effect.promise(() => unpin);
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeNull();
        const pin = h.commands.pin.run(h.registry, target);
        const second = yield* Queue.take(h.requests);
        const observed: boolean[] = [];
        const unsubscribe = h.registry.subscribe(h.visibleAtom, (snapshot) =>
          observed.push(snapshot?.threads[0]?.pinnedAt != null),
        );
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 4,
          threads: [{ ...SNAPSHOT.threads[0]!, pinnedAt: NOW }],
        };
        if (order === "event-first") h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        yield* Deferred.succeed(second.reply, { sequence: 4 });
        yield* Effect.promise(() => pin);
        if (order === "ack-first") h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        const entries = h.registry.get(
          h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID),
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          status: "unknown",
          key: { commandId: first.command.commandId },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toEqual(NOW);
        expect(observed).not.toContain(false);
        unsubscribe();
      }),
  );

  it.effect("rolls back when the connection disappears before the request is sent", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* SubscriptionRef.set(h.supervisor.session, Option.none());
      const result = h.commands.pin.run(h.registry, target);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeDefined();
      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      expect(
        h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))[0]?.status,
      ).toBe("rejected");
      expect(yield* Queue.size(h.requests)).toBe(0);
    }),
  );

  it.effect("keeps a lost reply unconfirmed without replaying or rolling back the pin", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.pin.run(h.registry, target);
      const request = yield* Queue.take(h.requests);
      yield* Deferred.fail(
        request.reply,
        new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
      );
      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), { ...SNAPSHOT, snapshotSequence: 100 });
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeDefined();
      expect(
        h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))[0]?.status,
      ).toBe("unknown");
      expect(yield* Queue.size(h.requests)).toBe(0);
    }),
  );

  it.effect.each(["denied", "unsupported"] as const)(
    "refuses known %s pinning synchronously without projecting or sending",
    (reason) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        if (reason === "denied") {
          const session: AuthSessionState = {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: [],
            permissions: [],
          };
          h.registry.set(testSessionAtoms(ENVIRONMENT_ID), session);
        } else {
          h.registry.update(testConfigAtoms(ENVIRONMENT_ID), (config) => ({
            ...config,
            environment: {
              capabilities: { ...config.environment.capabilities, threadPinning: false },
            },
          }));
        }
        const result = h.commands.pin.run(h.registry, target);
        expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
        expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
        expect(
          h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID)),
        ).toEqual([]);
        expect(yield* Queue.size(h.requests)).toBe(0);
      }),
  );

  it.effect("shows intent before session hydration and rolls back a later permission refusal", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const allowed = h.registry.get(testSessionAtoms(ENVIRONMENT_ID))!;
      h.registry.set(testSessionAtoms(ENVIRONMENT_ID), null);
      expect(h.commands.pin.requiredScopes()).toEqual(["orchestration:operate"]);
      expect(h.registry.get(h.commands.pin.permissionAtom(ENVIRONMENT_ID))).toBe(false);
      const result = h.commands.pin.run(h.registry, target);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeDefined();
      h.registry.set(testSessionAtoms(ENVIRONMENT_ID), { ...allowed, scopes: [], permissions: [] });
      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      expect(
        h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))[0]?.status,
      ).toBe("rejected");
      expect(yield* Queue.size(h.requests)).toBe(0);
      h.registry.set(testSessionAtoms(ENVIRONMENT_ID), allowed);
      expect(h.registry.get(h.commands.pin.permissionAtom(ENVIRONMENT_ID))).toBe(true);
    }),
  );

  it.effect("does not bring an old account's intent back after its late acknowledgement", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const accountA = { accountId: "person-a", readClerkToken: () => Effect.succeed(null) };
      h.registry.set(managedRelaySessionAtom, accountA);
      const result = h.commands.pin.run(h.registry, target);
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeDefined();
      h.registry.set(managedRelaySessionAtom, { ...accountA, accountId: "person-b" });
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* Effect.promise(() => result);
      h.registry.set(managedRelaySessionAtom, accountA);
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      expect(h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))).toEqual(
        [],
      );
    }),
  );
});
