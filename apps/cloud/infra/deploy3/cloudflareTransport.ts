import { readBoundedApiResponse } from "./httpResponse.ts";
import { boundedOperation, clockMillis, isoAt } from "./platform.ts";
const API_ROOT = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 20_000;
export type JsonRecord = Record<string, unknown>;
export type CloudflareCallResult = {
  readonly result: unknown;
  readonly resultInfo: JsonRecord | undefined;
  readonly status: number;
  readonly notFound: boolean;
};

export type Deploy3Observation = {
  readonly type:
    | "cloudflare-mutation-started"
    | "cloudflare-api-response"
    | "cloudflare-mutation-uncertain"
    | "cloudflare-read-failed";
  readonly requestId: string;
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly atUtc: string;
  readonly httpStatus?: number;
  readonly responseBytes?: number;
  readonly errorClass?: string;
};

export interface Deploy3CloudflareApi {
  readonly accountId: string;
  readonly accountPath: string;
  request(
    key: string,
    method: "GET" | "DELETE",
    path: string,
    allow404?: boolean,
  ): Promise<CloudflareCallResult>;
}

type ApiOptions = {
  readonly accountId: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly observe?: (event: Deploy3Observation) => void | Promise<void>;
};

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeCloudflareId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function errorClass(error: unknown): string {
  return isRecord(error) && typeof error.name === "string" ? error.name : "Error";
}

export function createDeploy3CloudflareApi({
  accountId,
  token,
  fetchImpl = globalThis.fetch,
  observe = () => {},
}: ApiOptions): Deploy3CloudflareApi {
  const accountPath = `/accounts/${accountId}`;
  let sequence = 0;

  return {
    accountId,
    accountPath,
    async request(key, method, path, allow404 = false) {
      const requestId = String(++sequence).padStart(5, "0");
      const safePath = path.replace(accountId, "<account>");
      const mutation = method !== "GET";
      let dispatched = false;
      if (mutation) {
        await observe({
          type: "cloudflare-mutation-started",
          requestId,
          key,
          method,
          path: safePath,
          atUtc: isoAt(clockMillis()),
        });
      }
      try {
        const response = await boundedOperation(async (signal) => {
          dispatched = true;
          const fetched = await fetchImpl(`${API_ROOT}${accountPath}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}` },
            signal,
            redirect: "error",
            cache: "no-store",
          });
          return { response: fetched, bytes: await readBoundedApiResponse(fetched) };
        }, REQUEST_TIMEOUT_MS);
        await observe({
          type: "cloudflare-api-response",
          requestId,
          key,
          method,
          path: safePath,
          atUtc: isoAt(clockMillis()),
          httpStatus: response.response.status,
          responseBytes: response.bytes.byteLength,
        });
        if (allow404 && response.response.status === 404) {
          return { result: null, resultInfo: undefined, status: 404, notFound: true };
        }
        let envelope: JsonRecord | undefined;
        if (response.bytes.byteLength > 0) {
          try {
            envelope = JSON.parse(new TextDecoder().decode(response.bytes)) as JsonRecord;
          } catch {
            throw new Error("invalid JSON response");
          }
        }
        const emptyDelete = mutation && response.response.ok && response.bytes.byteLength === 0;
        if (!response.response.ok || (envelope?.success !== true && !emptyDelete)) {
          throw new Error(`HTTP ${response.response.status}`);
        }
        return {
          result: envelope?.result,
          resultInfo: isRecord(envelope?.result_info) ? envelope.result_info : undefined,
          status: response.response.status,
          notFound: false,
        };
      } catch (error) {
        try {
          await observe({
            type:
              mutation && dispatched ? "cloudflare-mutation-uncertain" : "cloudflare-read-failed",
            requestId,
            key,
            method,
            path: safePath,
            atUtc: isoAt(clockMillis()),
            errorClass: errorClass(error),
          });
        } catch {
          // A broken journal must not trigger a retry of the mutation.
        }
        throw Object.assign(new Error(`Cloudflare operation failed: ${key}`), {
          code: "CLOUDFLARE_UNCERTAIN",
          key,
        });
      }
    },
  };
}
