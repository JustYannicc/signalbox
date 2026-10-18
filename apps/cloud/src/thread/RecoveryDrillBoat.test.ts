import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { makeBoatRecoveryControlWithClient } from "./RecoveryDrillBoat.ts";

const makeBoatRecoveryControl = (client: HttpClient.HttpClient) =>
  makeBoatRecoveryControlWithClient(client, {
    apiUrl: "https://boat.test/api/v1",
    apiKey: Redacted.make("worker-only-key"),
  });

interface RequestRecord {
  readonly method: string;
  readonly url: string;
  readonly confirmation: string | null;
  readonly authorization: string | null;
}

const apiWith = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
  requests: Array<RequestRecord>,
) =>
  HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      confirmation: request.headers["x-ascii-confirm-delete"] ?? null,
      authorization: request.headers.authorization ?? null,
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
  });

describe("BoatRecoveryControl", () => {
  it.effect("reads fresh sanitized provider state and confirms the exact DELETE target", () =>
    Effect.gen(function* () {
      const requests: Array<RequestRecord> = [];
      let state = "ready";
      const control = makeBoatRecoveryControl(
        apiWith((request) => {
          if (request.method === "DELETE") return new Response(null, { status: 204 });
          return Response.json({
            sandbox: {
              id: "bx_old",
              state,
              hydrated: true,
              error: "private failure detail",
              setupError: "private setup detail",
            },
          });
        }, requests),
      );

      expect(yield* control.inspect("bx_old")).toEqual({
        machineId: "bx_old",
        exists: true,
        state: "ready",
        hydrated: true,
      });
      state = "provider detail with spaces";
      expect(yield* control.inspect("bx_old")).toEqual({
        machineId: "bx_old",
        exists: true,
        state: "unknown",
        hydrated: true,
      });
      yield* control.remove("bx_old");
      expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
        ["GET", "/api/v1/sandboxes/bx_old"],
        ["GET", "/api/v1/sandboxes/bx_old"],
        ["DELETE", "/api/v1/sandboxes/bx_old"],
      ]);
      expect(requests[2]?.confirmation).toBe("bx_old");
      expect(requests.every((request) => request.authorization === "Bearer worker-only-key")).toBe(
        true,
      );
    }),
  );

  it.effect("represents Boat 404 as absent and preserves non-404 provider errors", () =>
    Effect.gen(function* () {
      const requests: Array<RequestRecord> = [];
      const absent = makeBoatRecoveryControl(
        apiWith(() => Response.json({ code: "not_found" }, { status: 404 }), requests),
      );
      expect(yield* absent.inspect("bx_old")).toEqual({
        machineId: "bx_old",
        exists: false,
        state: null,
        hydrated: null,
      });

      const failing = makeBoatRecoveryControl(
        apiWith(
          () =>
            Response.json(
              { code: "unavailable", message: "private provider details" },
              { status: 503 },
            ),
          requests,
        ),
      );
      const error = yield* Effect.flip(failing.inspect("bx_old"));
      expect(error).toMatchObject({ _tag: "BoatApiError", operation: "get", status: 503 });
    }),
  );

  it.effect("rejects a provider readback for a different machine ID", () =>
    Effect.gen(function* () {
      const requests: Array<RequestRecord> = [];
      const control = makeBoatRecoveryControl(
        apiWith(() => Response.json({ sandbox: { id: "bx_other", state: "ready" } }), requests),
      );
      const error = yield* Effect.flip(control.inspect("bx_old"));
      expect(error).toMatchObject({ _tag: "BoatApiError", code: "id_mismatch" });
    }),
  );
});
