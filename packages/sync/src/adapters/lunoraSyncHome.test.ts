import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { LunoraClient } from "lunorash/client";
import { describe, expect, it, vi } from "@effect/vitest";

import { defineHome, type SyncHome } from "@signalbox/sync/definition";
import {
  makeLunoraSyncHome,
  type LunoraSyncHomeOptions,
} from "@signalbox/sync/adapters/lunoraSyncHome";

const actor = Schema.Struct({ id: Schema.String });
const home = defineHome(
  { actor, home: Schema.String, tables: {} },
  ({ view, change, projection }) => ({
    views: {
      at: view({
        input: Schema.DateTimeUtcFromString,
        output: Schema.Struct({ at: Schema.DateTimeUtcFromString }),
        failure: Schema.Literal("view_failed"),
        run: (_context, at) => Effect.succeed({ at }),
      }),
    },
    changes: {
      at: change({
        input: Schema.DateTimeUtcFromString,
        output: Schema.DateTimeUtcFromString,
        failure: Schema.DateTimeUtcFromString,
        run: (_context, at) => Effect.succeed(at),
      }),
      nullable: change({
        input: Schema.Null,
        output: Schema.Null,
        failure: Schema.Never,
        run: () => Effect.succeed(null),
      }),
    },
    projections: {
      touch: projection({
        input: Schema.Void,
        output: Schema.Void,
        failure: Schema.Never,
        run: () => Effect.void,
      }),
    },
  }),
);

const references = {
  views: { at: { __lunoraRef: "sync:observeAt" } },
  changes: {
    at: { __lunoraRef: "sync:changeAt" },
    nullable: { __lunoraRef: "sync:changeNullable" },
  },
  projections: { touch: { __lunoraRef: "sync:projectTouch" } },
} as const;

function harness() {
  let mutationResult: unknown = {
    _tag: "Committed",
    value: { defined: true, value: "2026-10-17T12:00:00.000Z" },
    receipt: "receipt-1",
  };
  let mutationBehavior:
    | ((reference: unknown, args: unknown, options: unknown) => Promise<unknown>)
    | undefined;
  const calls: Array<{
    readonly reference: unknown;
    readonly args: unknown;
    readonly options: unknown;
  }> = [];
  const client = {
    mutation: vi.fn((reference: unknown, args: unknown, options: unknown) => {
      calls.push({ reference, args, options });
      if (mutationBehavior !== undefined) return mutationBehavior(reference, args, options);
      return mutationResult instanceof Error
        ? Promise.reject(mutationResult)
        : Promise.resolve(mutationResult);
    }),
    subscribe: vi.fn(
      (
        _reference: unknown,
        _args: unknown,
        onData: (value: unknown) => void,
        options?: { readonly shardKey?: string },
      ) => {
        void options;
        queueMicrotask(() =>
          onData({
            _tag: "Value",
            value: { defined: true, value: { at: "2026-10-17T12:00:00.000Z" } },
            cursor: "cursor-1",
          }),
        );
        return () => undefined;
      },
    ),
    connectionStatus: () => "connected",
    onConnectionStatus: (listener: (status: string) => void) => {
      listener("connected");
      return () => undefined;
    },
  } as unknown as LunoraClient;

  const actorValue = { id: "alice" };
  const ingress = { source: "catalog-outbox" };
  const projectionCalls: Array<{
    readonly ingress: unknown;
    readonly reference: unknown;
    readonly args: unknown;
    readonly shardKey: string;
  }> = [];
  const options: LunoraSyncHomeOptions<typeof actorValue, typeof ingress> = {
    shardKey: "home:one",
    sessionFor: vi.fn((resolvedActor) => {
      expect(resolvedActor).toEqual(actorValue);
      return { client, shardKey: "home:one" };
    }),
    dispatchProjection: vi.fn((resolvedIngress, reference, args, shardKey) => {
      projectionCalls.push({ ingress: resolvedIngress, reference, args, shardKey });
      return Promise.resolve({
        _tag: "Committed",
        value: { defined: false },
        receipt: "receipt-p",
      });
    }),
  };

  const syncHome = makeLunoraSyncHome(home, references, options);

  return {
    actorValue,
    calls,
    client,
    ingress,
    options,
    projectionCalls,
    syncHome,
    setMutationResult(value: unknown) {
      mutationResult = value;
    },
    setMutationBehavior(
      behavior: (reference: unknown, args: unknown, options: unknown) => Promise<unknown>,
    ) {
      mutationBehavior = behavior;
    },
  };
}

describe("Lunora SyncHome facade", () => {
  it.effect(
    "keeps the actor in the bound session, encodes Date input, and pins shard + domain key",
    () =>
      Effect.gen(function* () {
        const test = harness();
        const input = DateTime.makeUnsafe("2026-10-17T12:00:00.000Z");

        const result = yield* test.syncHome.change(test.actorValue, "at", input, "op-7");

        expect(result).toEqual({ _tag: "Committed", value: input, receipt: "receipt-1" });
        expect(test.calls).toEqual([
          {
            reference: references.changes.at,
            args: {
              input: { defined: true, value: DateTime.formatIso(input) },
              operationKey: "op-7",
            },
            options: { shardKey: "home:one" },
          },
        ]);
        expect(JSON.stringify(test.calls[0]?.args)).not.toContain("alice");
        expect(test.options.sessionFor).toHaveBeenCalledWith(test.actorValue);
      }),
  );

  it.effect("decodes a declared failure using its typed schema", () =>
    Effect.gen(function* () {
      const test = harness();
      const failedAt = DateTime.makeUnsafe("2026-10-17T13:00:00.000Z");
      test.setMutationResult(
        Object.assign(new Error("domain failure"), {
          code: "SYNC_DOMAIN_FAILURE",
          data: {
            _tag: "SyncDomainFailure",
            failure: { defined: true, value: DateTime.formatIso(failedAt) },
          },
        }),
      );

      const result = yield* Effect.result(
        test.syncHome.change(test.actorValue, "at", failedAt, "op-fail"),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toEqual(failedAt);
      expect(test.calls).toHaveLength(1);
    }),
  );

  it.effect("returns Pending with the same key when the transport outcome is unknown", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setMutationResult(new Error("socket disconnected after dispatch"));

      const result = yield* test.syncHome.change(
        test.actorValue,
        "at",
        DateTime.makeUnsafe("2026-10-17T12:00:00.000Z"),
        "op-same",
      );

      expect(result).toEqual({ _tag: "Pending", operationKey: "op-same" });
    }),
  );

  it.effect("recovers a committed mutation under the same domain key", () =>
    Effect.gen(function* () {
      const test = harness();
      let sideEffects = 0;
      test.setMutationBehavior((_reference, args) => {
        expect(args).toMatchObject({ operationKey: "op-recover" });
        if (sideEffects === 0) {
          sideEffects += 1;
          return Promise.reject(new Error("reply lost after commit"));
        }
        return Promise.resolve({
          _tag: "Committed",
          value: {
            defined: true,
            value: DateTime.formatIso(DateTime.makeUnsafe("2026-10-17T12:00:00.000Z")),
          },
          receipt: "receipt-1",
        });
      });

      const input = DateTime.makeUnsafe("2026-10-17T12:00:00.000Z");
      const pending = yield* test.syncHome.change(test.actorValue, "at", input, "op-recover");
      const recovered = yield* test.syncHome.change(test.actorValue, "at", input, "op-recover");

      expect(pending).toEqual({ _tag: "Pending", operationKey: "op-recover" });
      expect(recovered).toEqual({ _tag: "Committed", value: input, receipt: "receipt-1" });
      expect(sideEffects).toBe(1);
      expect(test.calls).toHaveLength(2);
      expect(test.calls.map((call) => call.args)).toEqual([
        {
          input: { defined: true, value: DateTime.formatIso(input) },
          operationKey: "op-recover",
        },
        {
          input: { defined: true, value: DateTime.formatIso(input) },
          operationKey: "op-recover",
        },
      ]);
      expect(test.calls.map((call) => call.options)).toEqual([
        { shardKey: "home:one" },
        { shardKey: "home:one" },
      ]);
    }),
  );

  it.effect("keeps delivery-fenced writes recoverable by domain key", () =>
    Effect.gen(function* () {
      for (const code of ["DELIVERY_FENCED", "DELIVERY_RECEIPT_FENCED"] as const) {
        const test = harness();
        test.setMutationResult(Object.assign(new Error(code), { code }));

        const result = yield* test.syncHome.change(
          test.actorValue,
          "at",
          DateTime.makeUnsafe("2026-10-17T12:00:00.000Z"),
          "op-fenced",
        );

        expect(result).toEqual({ _tag: "Pending", operationKey: "op-fenced" });
      }
    }),
  );

  it.effect("maps known auth, input, and storage errors to SyncFailure", () =>
    Effect.gen(function* () {
      for (const [code, reason] of [
        ["FORBIDDEN", "denied"],
        ["INVALID_INPUT", "invalid_input"],
        ["SQL_UNAVAILABLE", "unavailable"],
        ["FUNCTION_FAILED", "unavailable"],
      ] as const) {
        const test = harness();
        test.setMutationResult(Object.assign(new Error(code), { code }));

        const result = yield* Effect.result(
          test.syncHome.change(
            test.actorValue,
            "at",
            DateTime.makeUnsafe("2026-10-17T12:00:00.000Z"),
            "op-known",
          ),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({ _tag: "SyncFailure", reason });
      }
    }),
  );

  it.effect("dispatches projections through the trusted port and handles Void codecs", () =>
    Effect.gen(function* () {
      const test = harness();

      const result = yield* test.syncHome.project(test.ingress, "touch", undefined, "delivery-3");

      expect(result).toEqual({ _tag: "Committed", value: undefined, receipt: "receipt-p" });
      expect(test.projectionCalls).toEqual([
        {
          ingress: test.ingress,
          reference: references.projections.touch,
          args: { input: { defined: false }, operationKey: "delivery-3" },
          shardKey: "home:one",
        },
      ]);
      expect(test.client.mutation).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps null distinct from Void in mutation inputs and outputs", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setMutationResult({
        _tag: "Committed",
        value: { defined: true, value: null },
        receipt: "receipt-null",
      });

      const result = yield* test.syncHome.change(test.actorValue, "nullable", null, "op-null");

      expect(result).toEqual({ _tag: "Committed", value: null, receipt: "receipt-null" });
      expect(test.calls).toEqual([
        {
          reference: references.changes.nullable,
          args: { input: { defined: true, value: null }, operationKey: "op-null" },
          options: { shardKey: "home:one" },
        },
      ]);
    }),
  );

  it.effect("delegates views with an encoded date and decodes returned dates", () =>
    Effect.gen(function* () {
      const test = harness();
      const requested = DateTime.makeUnsafe("2026-10-17T12:00:00.000Z");
      const result = yield* Stream.runHead(test.syncHome.view(test.actorValue, "at", requested));

      expect(Option.getOrThrow(result)).toEqual({
        _tag: "Snapshot",
        value: { at: requested },
        cursor: "cursor-1",
      });
      expect(test.client.subscribe).toHaveBeenCalledWith(
        references.views.at,
        { input: { defined: true, value: DateTime.formatIso(requested) } },
        expect.any(Function),
        expect.objectContaining({ shardKey: "home:one" }),
      );
    }),
  );
});

const typedHome: SyncHome<{ readonly source: "outbox" }, typeof home> = makeLunoraSyncHome<
  { readonly source: "outbox" },
  typeof home
>(home, references, {
  shardKey: "home:one",
  sessionFor: () => ({ client: {} as LunoraClient, shardKey: "home:one" }),
  dispatchProjection: (_ingress, _reference, _args) => Promise.resolve(undefined),
});
void typedHome.view({ id: "alice" }, "at", DateTime.makeUnsafe("2026-10-17T12:00:00.000Z"));
// @ts-expect-error A trusted projection is not exposed as a client view.
void typedHome.view({ id: "alice" }, "touch", undefined);
