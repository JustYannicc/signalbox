import { TerminalSessionSnapshot, ThreadId, type TerminalEvent } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { layerMemoryStore } from "../testing.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserTerminals from "./UserTerminals.ts";

const threadId = ThreadId.make("thread-1");
const terminalId = "term-1";
const acmeContextId = SignalboxContextId.make("org_acme");

const layer = UserTerminals.layer.pipe(Layer.provideMerge(layerMemoryStore));

const services = Effect.gen(function* () {
  return {
    terminals: yield* UserTerminals.UserTerminals,
    contexts: yield* UserContexts.UserContexts,
  };
});

const snapshot = (overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/scratch",
  worktreePath: null,
  status: "running",
  pid: 120,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "Shell",
  updatedAt: "2026-10-17T00:00:00.000Z",
  sequence: 0,
  ...overrides,
});

const started = (value: TerminalSessionSnapshot) => ({
  type: "started" as const,
  threadId,
  terminalId,
  sequence: value.sequence,
  snapshot: value,
});

const delivery = (
  sequence: number,
  events: ReadonlyArray<TerminalEvent>,
  contextId = PERSONAL_CONTEXT_ID,
) => ({
  threadId,
  contextId,
  sequence,
  updatedAt: `2026-10-17T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  events,
});

const metadataReader = (terminals: UserTerminals.UserTerminals["Service"]) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const fiber = yield* terminals.metadata.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    return fiber;
  });

const eventReader = (terminals: UserTerminals.UserTerminals["Service"]) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const fiber = yield* terminals.events.pipe(
      Stream.tap((event) =>
        event.type === "started" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    return fiber;
  });

describe("UserTerminals", () => {
  it.effect("snapshots and broadcasts session changes to both connected clients", () =>
    Effect.gen(function* () {
      const { terminals } = yield* services;
      const metadataClientA = yield* metadataReader(terminals);
      const metadataClientB = yield* metadataReader(terminals);
      const initial = snapshot({ history: "ready> ", sequence: 1 });
      yield* terminals.record(delivery(1, [started(initial)]));

      const metadataA = Array.from(yield* Fiber.join(metadataClientA));
      const metadataB = Array.from(yield* Fiber.join(metadataClientB));
      expect(metadataA).toEqual(metadataB);
      expect(metadataA[0]).toEqual({ type: "snapshot", terminals: [] });
      expect(metadataA[1]).toMatchObject({
        type: "upsert",
        terminal: {
          threadId,
          terminalId,
          status: "running",
          hasRunningSubprocess: false,
          updatedAt: "2026-10-17T00:00:01.000Z",
        },
      });

      const eventClientA = yield* eventReader(terminals);
      const eventClientB = yield* eventReader(terminals);
      const duplicate = {
        type: "output" as const,
        threadId,
        terminalId,
        sequence: 2,
        data: "duplicate",
      };
      const live = {
        type: "output" as const,
        threadId,
        terminalId,
        sequence: 2,
        data: " next",
      };
      yield* terminals.record(delivery(1, [duplicate]));
      yield* terminals.record(delivery(0, [{ ...duplicate, sequence: 0, data: "stale" }]));
      yield* terminals.record(delivery(5, [live]));

      const eventsA = Array.from(yield* Fiber.join(eventClientA));
      const eventsB = Array.from(yield* Fiber.join(eventClientB));
      expect(eventsA).toEqual(eventsB);
      expect(eventsA.map((event) => event.type)).toEqual(["started", "output"]);
      expect(eventsA[0]).toMatchObject({
        type: "started",
        snapshot: { history: "ready> ", sequence: 1 },
      });
      expect(eventsA[1]).toEqual(live);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("repairs a dropped close when a slow event reader resumes", () =>
    Effect.gen(function* () {
      const { terminals } = yield* services;
      yield* terminals.record(delivery(1, [started(snapshot())]));
      const ready = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const reader = yield* terminals.events.pipe(
        Stream.tap((event) =>
          event.type === "started"
            ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* terminals.record(delivery(2, [{ type: "closed", threadId, terminalId }]));
      const replacement = { ...snapshot(), terminalId: "term-2" };
      yield* terminals.record(delivery(3, [{ ...started(replacement), terminalId: "term-2" }]));
      for (let sequence = 4; sequence <= 36; sequence++) {
        yield* terminals.record(
          delivery(sequence, [
            {
              type: "output",
              threadId,
              terminalId: "term-2",
              sequence,
              data: "x",
            },
          ]),
        );
      }
      yield* Deferred.succeed(resume, undefined);
      expect(Array.from(yield* Fiber.join(reader))).toMatchObject([
        { type: "started", terminalId },
        { type: "closed", terminalId },
        { type: "started", terminalId: "term-2", snapshot: { history: "x".repeat(33) } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("treats an empty restart snapshot as authoritative and removes closed sessions", () =>
    Effect.gen(function* () {
      const { terminals } = yield* services;
      yield* terminals.record(
        delivery(1, [started(snapshot({ history: "old output", sequence: 1 }))]),
      );
      yield* terminals.record(
        delivery(2, [
          {
            type: "restarted",
            threadId,
            terminalId,
            sequence: 2,
            snapshot: snapshot({ history: "", sequence: 2 }),
          },
        ]),
      );
      yield* terminals.record(
        delivery(3, [{ type: "output", threadId, terminalId, sequence: 3, data: "new output" }]),
      );
      yield* terminals.record(
        delivery(2, [
          { type: "output", threadId, terminalId, sequence: 4, data: "stale delivery" },
        ]),
      );

      const current = Option.getOrThrow(yield* Stream.runHead(terminals.events));
      expect(current).toMatchObject({
        type: "started",
        snapshot: { history: "new output", sequence: 3 },
      });

      const metadata = yield* metadataReader(terminals);
      yield* terminals.record(delivery(4, [{ type: "closed", threadId, terminalId }]));
      expect(Array.from(yield* Fiber.join(metadata))).toMatchObject([
        { type: "snapshot", terminals: [{ threadId, terminalId }] },
        { type: "remove", threadId, terminalId },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("resets metadata when a context leaves and restores it if the context returns", () =>
    Effect.gen(function* () {
      const { terminals, contexts } = yield* services;
      yield* contexts.syncOrganizations([{ id: acmeContextId, name: "Acme" }]);
      yield* terminals.record(
        delivery(1, [started(snapshot({ history: "private output", sequence: 1 }))], acmeContextId),
      );

      const metadata = yield* metadataReader(terminals);
      yield* contexts.syncOrganizations([]);
      expect(Array.from(yield* Fiber.join(metadata))).toMatchObject([
        { type: "snapshot", terminals: [{ threadId, terminalId }] },
        { type: "snapshot", terminals: [] },
      ]);

      // The owner's index retains state while membership hides it from every client.
      yield* terminals.record(
        delivery(
          2,
          [{ type: "output", threadId, terminalId, sequence: 2, data: " while away" }],
          acmeContextId,
        ),
      );
      yield* contexts.syncOrganizations([{ id: acmeContextId, name: "Acme" }]);
      expect(Option.getOrThrow(yield* Stream.runHead(terminals.events))).toMatchObject({
        type: "started",
        snapshot: { history: "private output while away", sequence: 2 },
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
