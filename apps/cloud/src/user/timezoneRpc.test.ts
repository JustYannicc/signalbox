import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { PERSON_TIMEZONE_WS_METHODS as methods } from "@t3tools/contracts/personTimezone";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import { SqlError, UnknownError } from "effect/sql/SqlError";

import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";
import * as UserTimezone from "./UserTimezone.ts";
import { makeTimezoneHandlers } from "./timezoneRpc.ts";

const connect = (cloud: ReturnType<typeof makeMemoryCloud>, userId: string, writable = true) =>
  Effect.andThen(
    cloud.userDirectory
      .forUser(userId)
      .recordSignIn({ id: userId, email: `${userId}@example.test` }),
    RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({
            identity: { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" },
            userId,
            sid: "timezone-test",
            via: "client",
          }),
          CloudRpc.layerScopeAuthorization(
            writable
              ? [AuthOrchestrationReadScope, AuthSettingsWriteScope]
              : [AuthOrchestrationReadScope],
          ),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    ),
  );

describe("cloud person timezone", () => {
  it.effect("keeps storage failures and the operation in transport errors", () =>
    Effect.gen(function* () {
      const cause = new SqlError({ reason: new UnknownError({ cause: new Error("unavailable") }) });
      const failed = Effect.fail(cause);
      const handlers = yield* makeTimezoneHandlers.pipe(
        Effect.provide(
          Layer.succeed(
            UserTimezone.UserTimezone,
            UserTimezone.UserTimezone.of({
              settings: failed,
              timezone: failed,
              set: () => failed,
              report: () => failed,
            }),
          ),
        ),
      );
      for (const [operation, call] of [
        ["read", handlers[methods.get]()],
        ["set", handlers[methods.set]({ timezone: "UTC" })],
        ["report", handlers[methods.report]({ timezone: "UTC" })],
      ] as const) {
        const error = yield* call.pipe(Effect.flip);
        expect(error.operation).toBe(operation);
        expect(error.cause).toBe(cause);
        expect(error.message).not.toContain("unavailable");
      }
    }),
  );

  it.effect(
    "shares device detection across clients, preserves manual overrides, and restores detection",
    () =>
      Effect.gen(function* () {
        const cloud = makeMemoryCloud();
        const first = yield* connect(cloud, "alice");
        expect(yield* first[methods.get]({})).toEqual({
          timezone: "UTC",
          source: "device",
          deviceTimezone: null,
        });
        yield* first[methods.report]({ timezone: "Europe/Zurich" });
        const second = yield* connect(cloud, "alice");
        expect(yield* second[methods.get]({})).toEqual({
          timezone: "Europe/Zurich",
          source: "device",
          deviceTimezone: "Europe/Zurich",
        });
        yield* first[methods.set]({ timezone: "America/New_York" });
        expect(yield* second[methods.report]({ timezone: "Asia/Tokyo" })).toEqual({
          timezone: "America/New_York",
          source: "manual",
          deviceTimezone: "Asia/Tokyo",
        });
        expect(yield* first[methods.set]({ timezone: null })).toEqual({
          timezone: "Asia/Tokyo",
          source: "device",
          deviceTimezone: "Asia/Tokyo",
        });
        const other = yield* connect(cloud, "bob");
        expect(yield* other[methods.get]({})).toEqual({
          timezone: "UTC",
          source: "device",
          deviceTimezone: null,
        });
      }).pipe(Effect.scoped),
  );

  it.effect("denies both kinds of timezone writes without the settings grant", () =>
    Effect.gen(function* () {
      const rpc = yield* connect(makeMemoryCloud(), "alice", false);
      for (const write of [
        rpc[methods.set]({ timezone: "Europe/Zurich" }),
        rpc[methods.report]({ timezone: "Asia/Tokyo" }),
      ]) {
        expect(yield* write.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: AuthSettingsWriteScope,
        });
      }
      expect((yield* rpc[methods.get]({})).timezone).toBe("UTC");
    }).pipe(Effect.scoped),
  );
});
