import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { AUTOMATIONS_CLOUD_ONLY_MESSAGE } from "../signalbox/automationAvailability.ts";
import * as AutomationHttp from "./http.ts";

const routes = Layer.mergeAll(
  HttpRouter.add("*", "/api/hooks/automation_1/token", HttpServerResponse.text("workflow")),
  HttpRouter.add("*", "/api/hooks/callback_1/token", HttpServerResponse.text("callback")),
  HttpRouter.add("*", "/api/hooks/scheduled-task-1/token", HttpServerResponse.text("scheduled")),
).pipe(
  Layer.provide(AutomationHttp.automationWebhookMiddleware.layer),
  Layer.provide(HttpPlatform.layer),
  Layer.provide(NodeServices.layer),
);

it.effect("ends old automation and callback hooks with 410 without retrying the relay", () =>
  Effect.gen(function* () {
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    try {
      for (const hook of ["automation_1", "callback_1"]) {
        for (const method of ["GET", "POST", "PUT", "PATCH"] as const) {
          const response = yield* Effect.promise(() =>
            handler(
              new Request(`http://env.local/api/hooks/${hook}/token?source=timer`, {
                method,
                ...(method === "GET" ? {} : { body: "{}" }),
              }),
            ),
          );
          expect(response.status).toBe(410);
          expect(response.headers.get("x-t3-hook-outcome")).toBe("disabled");
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: "automations_cloud_only",
            message: AUTOMATIONS_CLOUD_ONLY_MESSAGE,
          });
        }
      }
    } finally {
      yield* Effect.promise(dispose);
    }
  }),
);

it.effect("lets scheduled task hooks reach the upstream route", () =>
  Effect.gen(function* () {
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    try {
      const response = yield* Effect.promise(() =>
        handler(
          new Request("http://env.local/api/hooks/scheduled-task-1/token", { method: "POST" }),
        ),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("scheduled");
    } finally {
      yield* Effect.promise(dispose);
    }
  }),
);
