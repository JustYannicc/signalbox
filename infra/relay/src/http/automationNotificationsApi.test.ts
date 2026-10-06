import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  RelayApi,
  RelayEnvironmentAuth,
  RelayEnvironmentPrincipal,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AutomationNotifications from "../agentActivity/AutomationNotifications.ts";
import { RELAY_HTTP_ROUTER_CONFIG } from "./Api.ts";
import { automationNotificationsApi } from "./automationNotificationsApi.ts";

const body = JSON.stringify({
  notification: {
    id: "run_1/s1",
    kind: "notify",
    title: "Ship it",
    body: "Shipped",
    deepLink: "/automations/environment-1/runs/run_1",
  },
  proof: "signed-proof",
});

const serve = (publish: AutomationNotifications.AutomationNotifications["Service"]["publish"]) =>
  Effect.gen(function* () {
    const routes = HttpApiBuilder.layer(
      HttpApi.make("RelayApi").add(RelayApi.groups.automationNotifications),
    ).pipe(
      Layer.provide(
        automationNotificationsApi.pipe(
          Layer.provide(
            Layer.succeed(AutomationNotifications.AutomationNotifications, { publish }),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeed(RelayEnvironmentAuth, {
          environmentBearer: (effect) =>
            effect.pipe(
              Effect.provideService(RelayEnvironmentPrincipal, {
                environmentId: "environment-1",
                environmentPublicKey: "environment-public-key",
              }),
            ),
        }),
      ),
      Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
    );
    const httpEffect = yield* HttpRouter.toHttpEffect(routes).pipe(
      Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
    );
    return (environmentId: string) =>
      httpEffect.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(
              `https://relay.test/v1/environments/${environmentId}/automation-notifications`,
              {
                method: "POST",
                headers: {
                  authorization: "Bearer environment-credential",
                  "content-type": "application/json",
                },
                body,
              },
            ),
          ),
        ),
      );
  });

describe("automation notification route", () => {
  it.effect("hands the linked environment's notification to the service", () =>
    Effect.gen(function* () {
      const published: Array<
        Parameters<AutomationNotifications.AutomationNotifications["Service"]["publish"]>[0]
      > = [];
      const request = yield* serve((input) =>
        Effect.sync(() => {
          published.push(input);
          return { ok: true, deliveries: [] };
        }),
      );
      expect((yield* request("environment-1")).status).toBe(200);
      expect(published).toMatchObject([
        {
          environmentId: "environment-1",
          environmentPublicKey: "environment-public-key",
          request: { proof: "signed-proof", notification: { id: "run_1/s1", body: "Shipped" } },
        },
      ]);
      // A credential for one environment can't send as another.
      expect((yield* request("environment-2")).status).toBe(401);
      expect(published).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a bad proof with 401", () =>
    Effect.gen(function* () {
      const request = yield* serve(() =>
        Effect.fail(
          new AutomationNotifications.AutomationNotificationProofInvalid({
            environmentId: "environment-1",
            notificationId: "run_1/s1",
            reason: "invalid_signature_or_payload",
            stage: "validate_claims",
          }),
        ),
      );
      expect((yield* request("environment-1")).status).toBe(401);
    }).pipe(Effect.scoped),
  );
});
