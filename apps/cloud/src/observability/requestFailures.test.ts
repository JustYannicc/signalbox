import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import * as Platform from "../platform.ts";
import { logRequestFailure } from "./requestFailures.ts";

const request = HttpServerRequest.fromWeb(new Request("https://cloud.test/api/.env?secret=x"));
const notFound = new HttpServerError.HttpServerError({
  reason: new HttpServerError.RouteNotFound({ request }),
});

describe("cloud request failure logging", () => {
  it.effect("keeps expected client failures quiet without hiding bugs in mixed causes", () =>
    Effect.gen(function* () {
      const events: Array<Logger.Options<unknown>> = [];
      const logger = Logger.make((event) => events.push(event));
      const record = (cause: Cause.Cause<unknown>) =>
        logRequestFailure(cause).pipe(Effect.provide(Logger.layer([logger])));

      yield* record(Cause.fail(notFound));
      yield* record(
        Cause.fail(
          new HttpServerError.HttpServerError({
            reason: new HttpServerError.RequestParseError({ request }),
          }),
        ),
      );
      for (const status of [400, 401, 403, 404, 409, 413, 429, 499]) {
        yield* record(Cause.fail(HttpServerResponse.empty({ status })));
        yield* record(Cause.die(HttpServerResponse.empty({ status })));
      }
      yield* record(Cause.interrupt());
      expect(events).toHaveLength(0);

      yield* record(Cause.die(new Error("private content")));
      yield* record(Cause.fail(HttpServerResponse.empty({ status: 500 })));
      yield* record(Cause.die(HttpServerResponse.empty({ status: 500 })));
      yield* record(Cause.fail({ _tag: "RouteNotFound" }));
      yield* record(Cause.combine(Cause.fail(notFound), Cause.die("private content")));
      yield* record(
        Cause.fail(
          new HttpServerError.HttpServerError({
            reason: new HttpServerError.InternalError({ request }),
          }),
        ),
      );
      expect(events).toHaveLength(6);
      expect(events.every((event) => event.logLevel === "Error")).toBe(true);
      expect(JSON.stringify(events.map((event) => event.message))).not.toContain("private content");
    }),
  );

  it.effect("preserves real router responses while suppressing only expected failures", () =>
    Effect.gen(function* () {
      const events: Array<unknown> = [];
      const logger = Logger.layer([Logger.make((event) => events.push(event))]);
      const router = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          HttpRouter.add("GET", "/bug", Effect.die(new Error("private content"))),
          HttpRouter.add("GET", "/denied", Effect.fail(HttpServerResponse.empty({ status: 403 }))),
        ),
      );
      const context = yield* Effect.context<never>();
      const handler = HttpEffect.toWebHandler(
        router.pipe(
          Effect.tapCause(logRequestFailure),
          Effect.provide(logger),
          Effect.provide(context),
        ),
      );
      const missing = yield* Effect.promise(() =>
        handler(new Request("https://cloud.test/api/.env")),
      );
      const denied = yield* Effect.promise(() => handler(new Request("https://cloud.test/denied")));
      expect(missing.status).toBe(404);
      expect(denied.status).toBe(403);
      expect(events).toHaveLength(0);

      const bug = yield* Effect.promise(() => handler(new Request("https://cloud.test/bug")));
      expect(bug.status).toBe(500);
      expect(events).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps typed API request decoding quiet and reports response encoding bugs", () =>
    Effect.gen(function* () {
      const events: Array<unknown> = [];
      const logger = Logger.layer([Logger.make((event) => events.push(event))]);
      const api = HttpApi.make("test").add(
        HttpApiGroup.make("decode").add(
          HttpApiEndpoint.post("decode", "/decode", {
            payload: Schema.Struct({ count: Schema.Number }),
            success: Schema.Number,
          }),
          HttpApiEndpoint.get("badEncoding", "/bad-encoding", {
            success: Schema.Number.check(Schema.isFinite()),
          }),
        ),
      );
      const group = HttpApiBuilder.group(api, "decode", (handlers) =>
        handlers
          .handle("decode", ({ payload }) => Effect.succeed(payload.count))
          .handle("badEncoding", () => Effect.succeed(Number.NaN)),
      );
      const router = yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(api).pipe(Layer.provide(group), Layer.provide(Platform.layerHttp)),
      );
      const handler = HttpEffect.toWebHandler(
        router.pipe(Effect.tapCause(logRequestFailure), Effect.provide(logger)),
      );
      for (const body of ["{not json", '{"a":1}']) {
        const response = yield* Effect.promise(() =>
          handler(
            new Request("https://cloud.test/decode", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }),
          ),
        );
        expect(response.status).toBe(400);
      }
      expect(events).toHaveLength(0);

      const response = yield* Effect.promise(() =>
        handler(new Request("https://cloud.test/bad-encoding")),
      );
      expect(response.status).toBe(500);
      expect(events).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
