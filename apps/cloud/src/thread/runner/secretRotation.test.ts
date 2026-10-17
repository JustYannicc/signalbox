// @effect-diagnostics cryptoRandomUUID:off - secrets are generated throwaways.
import { expect, it } from "@effect/vitest";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { makeMemoryCloud } from "../../testing.ts";
import { UserDirectory } from "../../user/UserDirectory.ts";
import * as ThreadSends from "../egress/ThreadSends.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { serveSessionRequest } from "../session/sessionRoutes.ts";
import { connect, freshDatabase, launch, personal, withObject } from "./runnerTestKit.ts";

const a = `sk-a-${crypto.randomUUID()}`;
const b = `sk-b-${crypto.randomUUID()}`;
const rollbackValue = `sk-rollback-${crypto.randomUUID()}`;

it.effect(
  "A-to-B-to-A registration replaces current substitution values atomically while retaining redaction history",
  () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine, "rotation", personal);
        yield* connect(runner);
        const token = (yield* runner.work).sessions?.token ?? "";
        const sends = yield* ThreadSends.ThreadSends.pipe(
          Effect.provide(
            ThreadSends.layer.pipe(
              Layer.provide(Layer.succeedContext(context)),
              Layer.provide(Layer.succeed(UserDirectory, makeMemoryCloud().userDirectory)),
            ),
          ),
        );
        const store = Context.get(context, ThreadStore);
        const register = (value: string | null) =>
          serveSessionRequest({
            method: "POST",
            url: `http://cloud.test${SESSION_PATHS.secrets}`,
            token,
            body: JSON.stringify({ secrets: value === null ? [] : [{ name: "KEY", value }] }),
          }).pipe(Effect.provide(context));
        let revision = 0;
        for (const value of [a, b, a]) {
          expect((yield* register(value)).status).toBe(200);
          expect((yield* store.secretValues).revision).toBe(++revision);
          const current = yield* sends.secrets;
          expect(current.length === 1 && current[0]?.value === value).toBe(true);
        }
        expect((yield* store.secretValues).values).toHaveLength(2);
        const failed = yield* serveSessionRequest({
          method: "POST",
          url: `http://cloud.test${SESSION_PATHS.secrets}`,
          token,
          body: JSON.stringify({
            secrets: [{ name: "KEY", value: rollbackValue }],
            sources: [
              { name: "KEY", environment: "env-one" },
              { name: "KEY", environment: "env-two" },
            ],
          }),
        }).pipe(Effect.provide(context));
        expect(failed.status).toBe(500);
        expect((yield* store.secretValues).revision).toBe(revision);
        expect((yield* sends.secrets)[0]?.value === a).toBe(true);
        expect((yield* store.secretValues).values).toHaveLength(2);
        expect((yield* register(null)).status).toBe(200);
        expect(yield* sends.secrets).toHaveLength(0);
        expect((yield* store.secretValues).values).toHaveLength(2);
      }),
    ),
);
