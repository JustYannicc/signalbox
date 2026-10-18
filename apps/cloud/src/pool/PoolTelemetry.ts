import * as Context from "effect/Context";

import type { CloudFields } from "../observability/Evlog.ts";
import {
  isManagementRequest,
  releaseFromHeaders,
  unknownRelease,
  type CliProxyApiRelease,
} from "./CliProxyApiRuntime.ts";

export interface PoolCallEvent extends Pick<CloudFields, "person" | "thread" | "turn"> {
  readonly action: "pool.call";
  readonly cliProxyApi: CliProxyApiRelease;
  readonly status: number;
  readonly poolCall: {
    readonly backing: "managed" | "external" | "linked";
    readonly kind: "management" | "model" | "link";
    readonly outcome: "response" | "http_error" | "transport_error";
    /** Until response headers, including any container startup. Never waits for a body. */
    readonly headersMs: number;
  };
}

export const PoolTelemetry = Context.Reference<{ readonly submit: (event: PoolCallEvent) => void }>(
  "@signalbox/cloud/pool/PoolTelemetry",
  { defaultValue: () => ({ submit: () => {} }) },
);

/** Each hop retains its own target evidence, even when another request stops the container. */
export const observePoolCall = async (input: {
  readonly request: Request;
  readonly baseUrl: string;
  readonly backing: PoolCallEvent["poolCall"]["backing"];
  readonly correlation?: Pick<CloudFields, "person" | "thread" | "turn">;
  readonly release: () => CliProxyApiRelease;
  readonly send: (onSend: () => void) => Promise<Response>;
  readonly submit: (event: PoolCallEvent) => void;
}) => {
  const startedAt = performance.now();
  const kind =
    input.backing === "linked"
      ? "link"
      : isManagementRequest(input.request, input.baseUrl)
        ? "management"
        : "model";
  let release = unknownRelease;
  const record = (status: number, outcome: PoolCallEvent["poolCall"]["outcome"]) =>
    input.submit({
      ...input.correlation,
      action: "pool.call",
      cliProxyApi: release,
      status,
      poolCall: {
        backing: input.backing,
        kind,
        outcome,
        headersMs: Math.max(0, performance.now() - startedAt),
      },
    });
  let response: Response;
  try {
    response = await input.send(() => {
      // External/link targets can change independently. Their model replies prove no release.
      release = input.backing === "managed" ? input.release() : unknownRelease;
    });
  } catch (error) {
    record(502, "transport_error");
    throw error;
  }
  if (kind === "management") release = releaseFromHeaders(response.headers);
  record(response.status, response.status >= 400 ? "http_error" : "response");
  return response;
};
