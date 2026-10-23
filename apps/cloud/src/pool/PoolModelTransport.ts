import * as Context from "effect/Context";

import type { ServedModel } from "./cliProxyApi.ts";

/** Model metadata and request handler supplied by a pool's local host. */
export interface PoolModelTransport {
  readonly id: string;
  readonly models: ReadonlyArray<Omit<ServedModel, "registration">>;
  readonly fetch: (request: Request) => Promise<Response>;
}

/** The live request handler is separate from persisted model registration. */
export interface PoolModelTransportHandler {
  readonly id: string;
  readonly fetch: (request: Request) => Promise<Response>;
}

export const ActivePoolModelTransport = Context.Reference<PoolModelTransportHandler | null>(
  "@signalbox/cloud/pool/ActivePoolModelTransport",
  { defaultValue: () => null },
);

const MODEL_REQUEST_PATHS = new Set(["/v1/messages", "/v1/responses"]);

/** Reads only the model selector from the two request paths the cloud gateway serves. */
export const requestedModelId = async (path: string, request: Request): Promise<string | null> => {
  if (request.method !== "POST") return null;
  const contentType = request.headers.get("content-type");
  if (contentType !== null && !contentType.toLowerCase().includes("application/json")) {
    return null;
  }
  try {
    if (!MODEL_REQUEST_PATHS.has(new URL(path, "http://pool.local").pathname)) return null;
    const body: unknown = await request.clone().json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const model = (body as Readonly<Record<string, unknown>>).model;
    return typeof model === "string" && model.trim().length > 0 ? model : null;
  } catch {
    return null;
  }
};
