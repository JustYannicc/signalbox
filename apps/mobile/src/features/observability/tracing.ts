import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { CLIENT_TRACES_PATH, contentFreeTracer } from "@t3tools/shared/clientTraceSafety";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import Constants from "expo-constants";

import type { SavedRemoteConnection } from "../../lib/connection";

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

export interface AuthenticatedCloudTraceConnection {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}

export type CloudTraceConnectionProvider = () => Promise<AuthenticatedCloudTraceConnection | null>;

const OTLP_EXPORTER_URL = `https://signalbox-traces.invalid${CLIENT_TRACES_PATH}`;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let connectionProvider: CloudTraceConnectionProvider = async () => null;

/** The connection is resolved at export time so sign-in, rotation, and sign-out take effect live. */
export function configureCloudTraceConnectionProvider(
  provider: CloudTraceConnectionProvider,
): void {
  connectionProvider = provider;
}

function isCloudBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    return (
      url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

/** Select the signed-in Signalbox Cloud connection from its server capability and saved bearer. */
export function resolvePrimaryCloudTraceConnection(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  connections: Readonly<Record<EnvironmentId, SavedRemoteConnection>>,
): AuthenticatedCloudTraceConnection | null {
  const environmentIds = [...configs]
    .filter(([, config]) => config.environment.capabilities.signalboxCloud === true)
    .map(([environmentId]) => environmentId)
    .sort((left, right) => String(left).localeCompare(String(right)));

  for (const environmentId of environmentIds) {
    const connection = connections[environmentId];
    if (
      connection?.bearerToken &&
      connection.bearerToken.trim() !== "" &&
      isCloudBaseUrl(connection.httpBaseUrl)
    ) {
      return {
        httpBaseUrl: connection.httpBaseUrl,
        bearerToken: connection.bearerToken,
      };
    }
  }

  return null;
}

function authenticatedFetch(
  fetchFn: typeof globalThis.fetch,
  provider: CloudTraceConnectionProvider,
): typeof globalThis.fetch {
  return async (_input, init) => {
    let connection: AuthenticatedCloudTraceConnection | null;
    try {
      connection = await provider();
    } catch {
      connection = null;
    }

    if (
      connection === null ||
      connection.bearerToken.trim() === "" ||
      !isCloudBaseUrl(connection.httpBaseUrl)
    ) {
      // Drop unsigned batches locally without making the exporter back off for a minute.
      return new Response(null, { status: 202 });
    }

    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${connection.bearerToken}`);
    return fetchFn(new URL(CLIENT_TRACES_PATH, connection.httpBaseUrl).toString(), {
      ...init,
      headers,
    });
  };
}

export function layerFromConnectionProvider(
  provider: CloudTraceConnectionProvider,
  resource: TracingResource,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
) {
  const layerFetchClient = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, authenticatedFetch(fetchFn, provider))),
  );

  const layerTracer = Layer.unwrap(
    Effect.gen(function* () {
      const delegate = yield* OtlpTracer.make({
        url: OTLP_EXPORTER_URL,
        maxBatchSize: 128,
        resource: {
          serviceName: "signalbox-mobile",
          serviceVersion: resource.serviceVersion,
          attributes: {
            "service.namespace": "signalbox",
            "service.runtime": "react-native",
            "service.component": "mobile",
            "t3.client.surface": `mobile-${resource.appVariant}`,
          },
        },
      });
      return Layer.succeed(Tracer.Tracer, contentFreeTracer(delegate));
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        OtlpExporter.layerFlusher,
        OtlpSerialization.layerJson,
        layerFetchClient,
        Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
      ),
    ),
  );

  return Layer.mergeAll(
    layerTracer,
    Layer.succeed(Tracer.MinimumTraceLevel, "Info"),
    Layer.succeed(References.TracerTimingEnabled, true),
  );
}

const appVariant =
  typeof Constants.expoConfig?.extra?.appVariant === "string"
    ? Constants.expoConfig.extra.appVariant
    : "unknown";

export const layer = layerFromConnectionProvider(() => connectionProvider(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant,
});
