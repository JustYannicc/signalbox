import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { CLIENT_TRACES_PATH } from "@t3tools/shared/clientTraceSafety";

import type { SavedRemoteConnection } from "../../lib/connection";
import * as Tracing from "./tracing";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

const resource = { appVariant: "test", serviceVersion: "1.2.3" } as const;
const cloudBaseUrl = "https://cloud-preview.example";
const connection = {
  httpBaseUrl: cloudBaseUrl,
  bearerToken: "workos-session-token",
};

const exportOneSpan = (
  provider: Tracing.CloudTraceConnectionProvider,
  fetchFn: typeof fetch,
  name = "client.operation",
) =>
  Effect.scoped(
    Layer.build(
      Layer.effectDiscard(Effect.void.pipe(Effect.withSpan(name))).pipe(
        Layer.provide(Tracing.layerFromConnectionProvider(provider, resource, fetchFn)),
      ),
    ),
  );

it.effect("exports content-free spans through the authenticated primary Cloud connection", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = Tracing.layerFromConnectionProvider(
    async () => connection,
    resource,
    fetchFn,
  );
  const layerTracedApplication = Layer.effectDiscard(
    Effect.void.pipe(
      Effect.withSpan("private text from a user message", {
        attributes: { "user.input": "private text from a user message" },
      }),
    ),
  ).pipe(Layer.provide(layerTracing));

  return Effect.scoped(Layer.build(layerTracedApplication)).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledOnce();
        const [url, init] = fetchFn.mock.calls[0]!;
        const payload = new TextDecoder().decode(init?.body as Uint8Array);
        expect(String(url)).toBe(`${cloudBaseUrl}${CLIENT_TRACES_PATH}`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer workos-session-token");
        expect(payload).toContain("client.operation");
        expect(payload).not.toContain("private text from a user message");
      }),
    ),
  );
});

it.effect("uses rotated credentials at export time and sends nothing after revocation", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  let currentConnection: Tracing.AuthenticatedCloudTraceConnection | null = connection;
  const provider = () => Promise.resolve(currentConnection);

  return Effect.gen(function* () {
    yield* exportOneSpan(provider, fetchFn);
    currentConnection = { ...connection, bearerToken: "rotated-session-token" };
    yield* exportOneSpan(provider, fetchFn);
    currentConnection = null;
    yield* exportOneSpan(provider, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const authorizationHeaders = fetchFn.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("authorization"),
    );
    expect(authorizationHeaders).toEqual([
      "Bearer workos-session-token",
      "Bearer rotated-session-token",
    ]);
  });
});

it.effect("does not let trace export failures change the application failure", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = Tracing.layerFromConnectionProvider(
    async () => connection,
    resource,
    fetchFn,
  );
  const failure = { durationNanos: 1n };
  const layerTracedApplication = Layer.effectDiscard(
    Effect.fail(failure).pipe(
      Effect.withSpan("client.operation"),
      Effect.exit,
      Effect.flatMap((exit) => {
        const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined;
        return reason && Cause.isFailReason(reason)
          ? Effect.sync(() => {
              expect(reason.error).toBe(failure);
            })
          : Effect.die(new Error("Expected the original typed failure."));
      }),
    ),
  ).pipe(Layer.provide(layerTracing));

  return Effect.scoped(Layer.build(layerTracedApplication)).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledOnce();
      }),
    ),
  );
});

it("selects the authenticated Signalbox Cloud connection", () => {
  const cloudId = "primary-cloud" as EnvironmentId;
  const otherId = "other" as EnvironmentId;
  const cloudConfig = {
    environment: { capabilities: { signalboxCloud: true } },
  } as ServerConfig;
  const otherConfig = {
    environment: { capabilities: { signalboxCloud: false } },
  } as ServerConfig;
  const connectionFor = (httpBaseUrl: string, bearerToken: string | null) =>
    ({ httpBaseUrl, bearerToken }) as SavedRemoteConnection;

  expect(
    Tracing.resolvePrimaryCloudTraceConnection(
      new Map([
        [otherId, otherConfig],
        [cloudId, cloudConfig],
      ]),
      {
        [otherId]: connectionFor("https://local.example", "local-token"),
        [cloudId]: connectionFor(cloudBaseUrl, "cloud-token"),
      },
    ),
  ).toEqual({ httpBaseUrl: cloudBaseUrl, bearerToken: "cloud-token" });

  expect(
    Tracing.resolvePrimaryCloudTraceConnection(new Map([[cloudId, cloudConfig]]), {
      [cloudId]: connectionFor(cloudBaseUrl, null),
    }),
  ).toBeNull();
});
