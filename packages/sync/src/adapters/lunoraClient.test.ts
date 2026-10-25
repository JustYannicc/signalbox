import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { LunoraClient } from "lunorash/client";
import { describe, expect, it } from "@effect/vitest";

import { makeSyncViewAtom } from "@signalbox/sync/atoms";
import { defineHome } from "@signalbox/sync/definition";
import { makeLunoraSyncViewClient } from "@signalbox/sync/adapters/lunoraClient";

class CountFailure extends Schema.TaggedError<CountFailure>()("CountFailure", {
  reason: Schema.String,
}) {}
const wireDate = Schema.decodeSync(Schema.DateFromString)("2025-01-02T03:04:05.000Z");

const home = defineHome(
  { actor: Schema.Struct({ id: Schema.String }), home: Schema.String, tables: {} },
  ({ view }) => ({
    views: {
      count: view({
        input: Schema.Struct({ folder: Schema.String }),
        output: Schema.Struct({ count: Schema.NumberFromString }),
        failure: CountFailure,
        run: () => Effect.succeed({ count: 0 }),
      }),
    },
    changes: {},
    projections: {},
  }),
);

type ObserveResult =
  | { readonly _tag: "Value"; readonly value: unknown; readonly cursor: string }
  | { readonly _tag: "Failure"; readonly failure: unknown };
type Status = "connected" | "connecting" | "idle" | "offline" | "polling";

function createTransport(initialStatus: Status = "connected") {
  let status = initialStatus;
  let onData: ((result: ObserveResult) => void) | undefined;
  let onError: ((error: { readonly code?: string; readonly message: string }) => void) | undefined;
  let args: unknown;
  let queryUnsubscribes = 0;
  let statusUnsubscribes = 0;
  const statusListeners = new Set<(status: Status) => void>();
  let resolveAttached!: () => void;
  const attached = new Promise<void>((resolve) => {
    resolveAttached = resolve;
  });
  const client = {
    connectionStatus: () => status,
    onConnectionStatus: (listener: (status: Status) => void) => {
      statusListeners.add(listener);
      listener(status);
      return () => {
        statusUnsubscribes += 1;
        statusListeners.delete(listener);
      };
    },
    subscribe: (
      _reference: unknown,
      nextArgs: unknown,
      nextOnData: (result: ObserveResult) => void,
      options?: {
        readonly onError?: (error: { readonly code?: string; readonly message: string }) => void;
      },
    ) => {
      args = nextArgs;
      onData = nextOnData;
      onError = options?.onError;
      resolveAttached();
      return () => {
        queryUnsubscribes += 1;
      };
    },
  } as unknown as LunoraClient;

  return {
    client,
    attached,
    get args() {
      return args;
    },
    get queryUnsubscribes() {
      return queryUnsubscribes;
    },
    get statusUnsubscribes() {
      return statusUnsubscribes;
    },
    emit(result: ObserveResult) {
      onData?.(result);
    },
    error(error: { readonly code?: string; readonly message: string }) {
      onError?.(error);
    },
    setStatus(next: Status) {
      status = next;
      for (const listener of statusListeners) listener(next);
    },
  };
}

const reference = { __lunoraRef: "counter:observe" } as const;
const resumeCursor = Schema.decodeSync(Schema.String.pipe(Schema.brand("SyncCursor")))(
  "opaque-cursor-with-binding",
);
const makeClient = (transport: ReturnType<typeof createTransport>) =>
  makeLunoraSyncViewClient(
    transport.client,
    home.views,
    { count: reference },
    { shardKey: "home-1" },
  );

const wireHome = defineHome(
  { actor: Schema.Struct({ id: Schema.String }), home: Schema.String, tables: {} },
  ({ view }) => ({
    views: {
      voidValue: view({
        input: Schema.Void,
        output: Schema.Void,
        failure: CountFailure,
        run: () => Effect.void,
      }),
      nullValue: view({
        input: Schema.Void,
        output: Schema.Null,
        failure: CountFailure,
        run: () => Effect.succeed(null),
      }),
      dateValue: view({
        input: Schema.Void,
        output: Schema.DateFromString,
        failure: CountFailure,
        run: () => Effect.succeed(wireDate),
      }),
    },
    changes: {},
    projections: {},
  }),
);

const wireReferences = {
  voidValue: { __lunoraRef: "wire:void" },
  nullValue: { __lunoraRef: "wire:null" },
  dateValue: { __lunoraRef: "wire:date" },
} as const;
const makeWireClient = (transport: ReturnType<typeof createTransport>) =>
  makeLunoraSyncViewClient(transport.client, wireHome.views, wireReferences, {
    shardKey: "wire-home",
  });

const input = { folder: "notes" };
const value = (count: number, cursor = `cursor-${count}`) => ({
  _tag: "Value" as const,
  value: { defined: true as const, value: { count: String(count) } },
  cursor,
});

function makeAsyncOutputHome() {
  let decode: (value: string) => Effect.Effect<string> = Effect.succeed;
  const AsyncString = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect((value: string) => decode(value)),
      encode: SchemaGetter.transform((value: string) => value),
    }),
  );
  const operations = defineHome(
    { actor: Schema.Struct({ id: Schema.String }), home: Schema.String, tables: {} },
    ({ view }) => ({
      views: {
        delayed: view({
          input: Schema.Void,
          output: AsyncString,
          failure: CountFailure,
          run: () => Effect.succeed("initial"),
        }),
      },
      changes: {},
      projections: {},
    }),
  );
  return {
    operations,
    setDecode(next: (value: string) => Effect.Effect<string>) {
      decode = next;
    },
  };
}

const asyncOutputReference = { __lunoraRef: "async:observe" } as const;
const asyncOutputValue = (value: string, cursor: string) => ({
  _tag: "Value" as const,
  value: { defined: true as const, value },
  cursor,
});
const makeAsyncOutputClient = (
  transport: ReturnType<typeof createTransport>,
  testHome: ReturnType<typeof makeAsyncOutputHome>,
) =>
  makeLunoraSyncViewClient(
    transport.client,
    testHome.operations.views,
    { delayed: asyncOutputReference },
    { shardKey: "async-home" },
  );

function observe<A, E>(stream: Stream.Stream<A, E>) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A>();
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(stream, (value) => Queue.offer(queue, value)),
    );
    return { queue, take: Queue.take(queue), fiber };
  });
}

describe("Lunora sync view client", () => {
  it.effect("uses one native subscription and emits complete replacement frames", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const client = makeClient(transport);
      const observed = yield* observe(client.view("count", input).pipe(Stream.take(3)));
      yield* Effect.promise(() => transport.attached);

      transport.emit(value(1));
      expect(yield* observed.take).toEqual({
        _tag: "Snapshot",
        value: { count: 1 },
        cursor: "cursor-1",
      });
      transport.emit(value(2));
      expect(yield* observed.take).toEqual({
        _tag: "Update",
        value: { count: 2 },
        cursor: "cursor-2",
      });
      transport.emit(value(3));
      expect(yield* observed.take).toEqual({
        _tag: "Update",
        value: { count: 3 },
        cursor: "cursor-3",
      });

      yield* Fiber.join(observed.fiber);
      expect(transport.args).toEqual({ input: { defined: true, value: input } });
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );

  it.effect("passes an opaque resume cursor and replaces the local value with Reset", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const client = makeClient(transport);
      const resume = resumeCursor;
      const observed = yield* observe(client.view("count", input, resume).pipe(Stream.take(1)));
      yield* Effect.promise(() => transport.attached);
      transport.emit(value(8, "fresh-cursor"));

      expect(transport.args).toEqual({ input: { defined: true, value: input }, resume });
      expect(yield* observed.take).toEqual({
        _tag: "Reset",
        value: { count: 8 },
        cursor: "fresh-cursor",
      });
      yield* Fiber.join(observed.fiber);
    }),
  );

  it.effect("marks the next replacement as Reset after a reconnect", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const client = makeClient(transport);
      const observed = yield* observe(client.view("count", input).pipe(Stream.take(2)));
      yield* Effect.promise(() => transport.attached);
      transport.emit(value(1));
      expect(yield* observed.take).toMatchObject({ _tag: "Snapshot", value: { count: 1 } });
      transport.setStatus("offline");
      transport.setStatus("connected");
      transport.emit(value(2));

      expect(yield* observed.take).toMatchObject({ _tag: "Reset", value: { count: 2 } });
      yield* Fiber.join(observed.fiber);
    }),
  );

  it.effect("revokes and stops on an authoritative FORBIDDEN subscription error", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const client = makeClient(transport);
      const observed = yield* observe(client.view("count", input));
      yield* Effect.promise(() => transport.attached);
      transport.emit(value(4));
      expect(yield* observed.take).toMatchObject({ _tag: "Snapshot", value: { count: 4 } });
      transport.error({ code: "FORBIDDEN", message: "AccessDenied" });

      expect(yield* observed.take).toEqual({ _tag: "Revoked" });
      yield* Fiber.join(observed.fiber);
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );

  it.effect("fails invalid cursor errors without exposing transport details", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const client = makeClient(transport);
      const observed = yield* observe(client.view("count", input));
      yield* Effect.promise(() => transport.attached);
      transport.error({ code: "INVALID_CURSOR", message: "private transport detail" });

      const failure = yield* Effect.flip(Fiber.join(observed.fiber));
      expect(failure).toMatchObject({ _tag: "SyncFailure", reason: "invalid_cursor" });
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );

  it.effect.each([
    "FORBIDDEN_SHARD",
    "UNAUTHORIZED",
    "UNAUTHENTICATED",
    "TOKEN_EXPIRED",
    "IDENTITY_MISMATCH",
    "OFFLINE_IDENTITY_CHANGED",
  ])("clears the last value and stops when the server returns %s", (code) =>
    Effect.gen(function* () {
      const transport = createTransport();
      const client = makeClient(transport);
      const observed = yield* observe(client.view("count", input));
      yield* Effect.promise(() => transport.attached);
      transport.emit(value(4));
      expect(yield* observed.take).toMatchObject({ _tag: "Snapshot", value: { count: 4 } });
      transport.error({ code, message: "AccessDenied" });

      expect(yield* observed.take).toEqual({ _tag: "Revoked" });
      yield* Fiber.join(observed.fiber);
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );

  it.effect("decodes declared operation failures into the view stream error channel", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const client = makeClient(transport);
      const observed = yield* observe(client.view("count", input));
      yield* Effect.promise(() => transport.attached);
      transport.emit({
        _tag: "Failure",
        failure: {
          defined: true,
          value: { _tag: "CountFailure", reason: "too many" },
        },
      });

      const failure = yield* Effect.flip(Fiber.join(observed.fiber));
      expect(failure).toMatchObject({ _tag: "CountFailure", reason: "too many" });
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );

  it.effect("preserves Void in JSON input and output wrappers", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const observed = yield* observe(
        makeWireClient(transport).view("voidValue", undefined).pipe(Stream.take(1)),
      );
      yield* Effect.promise(() => transport.attached);
      expect(transport.args).toEqual({ input: { defined: false } });
      transport.emit({ _tag: "Value", value: { defined: false }, cursor: "void-cursor" });

      expect(yield* observed.take).toEqual({
        _tag: "Snapshot",
        value: undefined,
        cursor: "void-cursor",
      });
      yield* Fiber.join(observed.fiber);
    }),
  );

  it.effect("keeps Null distinct from an absent Void value", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const observed = yield* observe(
        makeWireClient(transport).view("nullValue", undefined).pipe(Stream.take(1)),
      );
      yield* Effect.promise(() => transport.attached);
      transport.emit({
        _tag: "Value",
        value: { defined: true, value: null },
        cursor: "null-cursor",
      });

      expect(yield* observed.take).toEqual({
        _tag: "Snapshot",
        value: null,
        cursor: "null-cursor",
      });
      yield* Fiber.join(observed.fiber);
    }),
  );

  it.effect("decodes Date values from their JSON encoding", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const observed = yield* observe(
        makeWireClient(transport).view("dateValue", undefined).pipe(Stream.take(1)),
      );
      yield* Effect.promise(() => transport.attached);
      transport.emit({
        _tag: "Value",
        value: { defined: true, value: "2025-01-02T03:04:05.000Z" },
        cursor: "date-cursor",
      });

      expect(yield* observed.take).toEqual({
        _tag: "Snapshot",
        value: wireDate,
        cursor: "date-cursor",
      });
      yield* Fiber.join(observed.fiber);
    }),
  );

  it.effect("conflates an async replacement backlog to the latest value", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const asyncHome = makeAsyncOutputHome();
      const firstDecodeStarted = yield* Deferred.make<void>();
      const releaseFirstDecode = yield* Deferred.make<void>();
      const latestDecodeStarted = yield* Deferred.make<void>();
      const releaseLatestDecode = yield* Deferred.make<void>();
      const decoded: Array<string> = [];
      asyncHome.setDecode((value) => {
        decoded.push(value);
        if (value === "1") {
          return Deferred.succeed(firstDecodeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstDecode)),
            Effect.as(value),
          );
        }
        if (value === "50") {
          return Deferred.succeed(latestDecodeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLatestDecode)),
            Effect.as(value),
          );
        }
        return Effect.succeed(value);
      });
      const client = makeAsyncOutputClient(transport, asyncHome);
      const observed = yield* observe(client.view("delayed", undefined));
      yield* Effect.promise(() => transport.attached);

      transport.emit(asyncOutputValue("1", "cursor-1"));
      yield* Deferred.await(firstDecodeStarted);
      for (let count = 2; count <= 50; count += 1) {
        transport.emit(asyncOutputValue(String(count), `cursor-${count}`));
      }

      yield* Deferred.succeed(releaseFirstDecode, undefined);
      yield* Deferred.await(latestDecodeStarted);
      expect(decoded).toEqual(["1", "50"]);
      expect(yield* observed.take).toEqual({
        _tag: "Snapshot",
        value: "1",
        cursor: "cursor-1",
      });

      yield* Deferred.succeed(releaseLatestDecode, undefined);
      expect(yield* observed.take).toEqual({
        _tag: "Update",
        value: "50",
        cursor: "cursor-50",
      });
      yield* Fiber.interrupt(observed.fiber);
    }),
  );

  it.effect("keeps a terminal domain failure ahead of replacement backlog", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const asyncHome = makeAsyncOutputHome();
      const decodeStarted = yield* Deferred.make<void>();
      const releaseDecode = yield* Deferred.make<void>();
      const decoded: Array<string> = [];
      asyncHome.setDecode((value) => {
        decoded.push(value);
        if (value !== "active") return Effect.succeed(value);
        return Deferred.succeed(decodeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseDecode)),
          Effect.as(value),
        );
      });
      const observed = yield* observe(
        makeAsyncOutputClient(transport, asyncHome).view("delayed", undefined),
      );
      yield* Effect.promise(() => transport.attached);

      transport.emit(asyncOutputValue("active", "cursor-active"));
      yield* Deferred.await(decodeStarted);
      transport.emit(asyncOutputValue("replaced", "cursor-replaced"));
      transport.emit({
        _tag: "Failure",
        failure: { defined: true, value: { _tag: "CountFailure", reason: "stopped" } },
      });
      transport.emit(asyncOutputValue("after-failure", "cursor-after-failure"));
      yield* Deferred.succeed(releaseDecode, undefined);

      expect(yield* observed.take).toEqual({
        _tag: "Snapshot",
        value: "active",
        cursor: "cursor-active",
      });
      const failure = yield* Effect.flip(Fiber.join(observed.fiber));
      expect(failure).toMatchObject({ _tag: "CountFailure", reason: "stopped" });
      expect(decoded).toEqual(["active"]);
    }),
  );

  it.effect("revocation wins while an async output codec is pending", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const asyncHome = makeAsyncOutputHome();
      const decodeStarted = yield* Deferred.make<void>();
      const releaseDecode = yield* Deferred.make<void>();
      const decodeFinished = yield* Deferred.make<void>();
      asyncHome.setDecode((value) =>
        Deferred.succeed(decodeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseDecode)),
          Effect.andThen(Deferred.succeed(decodeFinished, undefined)),
          Effect.as(value),
        ),
      );
      const observed = yield* observe(
        makeAsyncOutputClient(transport, asyncHome).view("delayed", undefined),
      );
      yield* Effect.promise(() => transport.attached);

      transport.emit(asyncOutputValue("stale", "cursor-stale"));
      yield* Deferred.await(decodeStarted);
      transport.error({ code: "FORBIDDEN", message: "AccessDenied" });

      expect(yield* observed.take).toEqual({ _tag: "Revoked" });
      yield* Fiber.join(observed.fiber);
      yield* Deferred.succeed(releaseDecode, undefined);
      yield* Deferred.await(decodeFinished);
      expect(Option.isNone(yield* Queue.poll(observed.queue))).toBe(true);
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );

  it.effect("ignores active and later decodes after stream teardown", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const asyncHome = makeAsyncOutputHome();
      const decodeStarted = yield* Deferred.make<void>();
      const releaseDecode = yield* Deferred.make<void>();
      const decodeFinished = yield* Deferred.make<void>();
      const decoded: Array<string> = [];
      asyncHome.setDecode((value) => {
        decoded.push(value);
        return Deferred.succeed(decodeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseDecode)),
          Effect.andThen(Deferred.succeed(decodeFinished, undefined)),
          Effect.as(value),
        );
      });
      const observed = yield* observe(
        makeAsyncOutputClient(transport, asyncHome).view("delayed", undefined),
      );
      yield* Effect.promise(() => transport.attached);

      transport.emit(asyncOutputValue("active", "cursor-active"));
      yield* Deferred.await(decodeStarted);
      yield* Fiber.interrupt(observed.fiber);
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);

      transport.emit(asyncOutputValue("after-teardown", "cursor-after-teardown"));
      expect(decoded).toEqual(["active"]);
      yield* Deferred.succeed(releaseDecode, undefined);
      yield* Deferred.await(decodeFinished);
      expect(Option.isNone(yield* Queue.poll(observed.queue))).toBe(true);
    }),
  );

  it.effect("rejects a malformed output wrapper without exposing details", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const observed = yield* observe(makeClient(transport).view("count", input));
      yield* Effect.promise(() => transport.attached);
      transport.emit({ _tag: "Value", value: { defined: "yes" }, cursor: "bad-cursor" });

      const failure = yield* Effect.flip(Fiber.join(observed.fiber));
      expect(failure).toMatchObject({ _tag: "SyncFailure", reason: "unavailable" });
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );

  it("requires each bound-home view client to own one Lunora client shard", () => {
    const transport = createTransport();
    makeClient(transport);

    expect(() =>
      makeLunoraSyncViewClient(
        transport.client,
        home.views,
        { count: reference },
        { shardKey: "another-home" },
      ),
    ).toThrow(/dedicated to one bound home shard/u);
  });

  it.effect("clears the atom value when authorization is revoked", () =>
    Effect.gen(function* () {
      const transport = createTransport();
      const registry = AtomRegistry.make();
      const atom = makeSyncViewAtom(makeClient(transport), "count", input);
      const valueSeen = yield* Deferred.make<void>();
      const observed = yield* Effect.forkChild(
        Stream.runCollect(
          AtomRegistry.toStream(registry, atom).pipe(
            Stream.tap((result) => {
              const state = Option.getOrNull(AsyncResult.value(result));
              return state?._tag === "Value" ? Deferred.succeed(valueSeen, undefined) : Effect.void;
            }),
            Stream.takeUntil((result) => {
              const state = Option.getOrNull(AsyncResult.value(result));
              return state?._tag === "Revoked";
            }),
          ),
        ),
      );
      yield* Effect.promise(() => transport.attached);
      transport.emit(value(9));
      yield* Deferred.await(valueSeen);
      transport.error({ code: "FORBIDDEN", message: "AccessDenied" });

      const results = yield* Fiber.join(observed);
      const states = results.flatMap((result) => Option.toArray(AsyncResult.value(result)));
      expect(states.at(-2)).toMatchObject({ _tag: "Value", value: { count: 9 } });
      expect(states.at(-1)).toEqual({ _tag: "Revoked" });
      registry.dispose();
      expect(transport.queryUnsubscribes).toBe(1);
      expect(transport.statusUnsubscribes).toBe(1);
    }),
  );
});
