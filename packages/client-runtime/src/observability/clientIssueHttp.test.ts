import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { ClientIssue } from "@t3tools/contracts/clientIssues";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { sendClientIssue } from "@t3tools/client-runtime/observability/client-issue-http";

const ISSUE: ClientIssue = {
  code: "runtime.uncaught",
  severity: "error",
  source: "exception",
  client: "desktop",
  release: "development",
  threadId: null,
  folderId: null,
  environmentId: "environment-1",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
};

const PRIMARY_TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Primary",
  httpBaseUrl: "https://primary.example.test",
  wsBaseUrl: "wss://primary.example.test/ws",
});

const prepared = (
  authorization: PreparedConnection["httpAuthorization"],
  target: PreparedConnection["target"] = PRIMARY_TARGET,
): PreparedConnection => ({
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl:
    target._tag === "PrimaryConnectionTarget"
      ? target.httpBaseUrl
      : "https://previous.example.test",
  socketUrl: "wss://primary.example.test/ws",
  httpAuthorization: authorization,
  target,
});

describe("client issue HTTP delivery", () => {
  it.effect.each([400, 403, 413, 415])("discards permanent rejection %s", (status) =>
    Effect.gen(function* () {
      const fetcher: typeof fetch = async () =>
        Response.json(
          { code: "client_issue_rejected", status, traceId: ISSUE.traceId },
          { status },
        );
      const result = yield* sendClientIssue(prepared(null), ISSUE).pipe(
        Effect.provide(layerRemoteHttpClient(fetcher)),
      );
      expect(result).toBe("discarded");
    }),
  );

  it.effect.each([401, 408, 429, 503])("retains retryable rejection %s", (status) =>
    Effect.gen(function* () {
      const fetcher: typeof fetch = async () =>
        Response.json(
          { code: "client_issue_rejected", status, traceId: ISSUE.traceId },
          { status },
        );
      const result = yield* sendClientIssue(prepared(null), ISSUE).pipe(
        Effect.provide(layerRemoteHttpClient(fetcher)),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect.each([
    { name: "cookie", authorization: null, expectedAuthorization: null },
    {
      name: "bearer",
      authorization: { _tag: "Bearer" as const, token: "bearer-token" },
      expectedAuthorization: "Bearer bearer-token",
    },
  ])(
    "preserves the issue trace and uses normal $name credentials",
    ({ authorization, expectedAuthorization }) =>
      Effect.gen(function* () {
        const requests: Request[] = [];
        const fetcher: typeof fetch = async (url, init) => {
          requests.push(new Request(url, init));
          return new Response(null, { status: 204 });
        };

        const result = yield* sendClientIssue(prepared(authorization), ISSUE).pipe(
          Effect.provide(layerRemoteHttpClient(fetcher)),
        );

        expect(result).toBeUndefined();
        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe(
          "https://primary.example.test/api/observability/client-issues",
        );
        expect(requests[0]!.method).toBe("POST");
        expect(requests[0]!.headers.get("traceparent")).toBe(
          `00-${ISSUE.traceId}-${ISSUE.spanId}-01`,
        );
        expect(requests[0]!.headers.get("authorization")).toBe(expectedAuthorization);
        expect(requests[0]!.credentials).toBe(authorization === null ? "include" : "same-origin");
      }),
  );

  it.effect("renews a rejected DPoP credential and disables HTTP trace replacement", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote",
      });
      const authorizations: Array<{ readonly rejectedAccessToken?: string }> = [];
      const proofs: Array<{
        readonly method: string;
        readonly url: string;
        readonly accessToken?: string;
      }> = [];
      const requests: Request[] = [];
      const remoteAuthorization = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("Unexpected bearer renewal."),
        authorizeDpop: () => Effect.die("Unexpected websocket authorization."),
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            authorizations.push(input);
            const renewed = input.rejectedAccessToken !== undefined;
            return {
              environmentId: target.environmentId,
              label: target.label,
              httpBaseUrl: renewed
                ? "https://renewed.example.test"
                : "https://current.example.test",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: renewed ? "renewed-token" : "current-token",
                expiresAtEpochMs: 3_600_000,
              },
            };
          }),
      });
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return `proof-${proofs.length}`;
          }),
      });
      const fetcher: typeof fetch = async (url, init) => {
        requests.push(new Request(url, init));
        if (requests.length === 1) {
          return Response.json(
            {
              code: "client_issue_rejected",
              status: 401,
              traceId: ISSUE.traceId,
            },
            { status: 401 },
          );
        }
        return new Response(null, { status: 204 });
      };
      const services = Layer.mergeAll(
        layerRemoteHttpClient(fetcher),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          remoteAuthorization,
        ),
      );

      yield* sendClientIssue(
        prepared({ _tag: "Dpop", accessToken: "expired-token", expiresAtEpochMs: 0 }, target),
        ISSUE,
      ).pipe(Effect.provide(services));

      expect(requests.map((request) => request.url)).toEqual([
        "https://current.example.test/api/observability/client-issues",
        "https://renewed.example.test/api/observability/client-issues",
      ]);
      expect(authorizations).toEqual([
        { expectedEnvironmentId: target.environmentId },
        { expectedEnvironmentId: target.environmentId, rejectedAccessToken: "current-token" },
      ]);
      expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
        "DPoP current-token",
        "DPoP renewed-token",
      ]);
      expect(requests.map((request) => request.headers.get("dpop"))).toEqual([
        "proof-1",
        "proof-2",
      ]);
      for (const request of requests) {
        expect(request.headers.get("traceparent")).toBe(`00-${ISSUE.traceId}-${ISSUE.spanId}-01`);
        expect(yield* Effect.promise(() => request.json())).toEqual(ISSUE);
      }
      expect(proofs.map(({ method, url, accessToken }) => ({ method, url, accessToken }))).toEqual([
        {
          method: "POST",
          url: "https://current.example.test/api/observability/client-issues",
          accessToken: "current-token",
        },
        {
          method: "POST",
          url: "https://renewed.example.test/api/observability/client-issues",
          accessToken: "renewed-token",
        },
      ]);
    }),
  );
});
