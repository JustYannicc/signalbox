// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The one-off Node harness sends a bounded RFC 6455 preflight.
import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";

export interface ConnectionDiagnostic {
  readonly levelId: string;
  readonly opens: number;
  readonly closes: number;
  readonly closeEvents: ReadonlyArray<{
    readonly code: number;
    readonly count: number;
    readonly wasClean: boolean;
  }>;
  readonly socketErrors: ReadonlyArray<{ readonly kind: string; readonly count: number }>;
  readonly readyStates: ReadonlyArray<number>;
  readonly incomingFrames: number;
  readonly incomingBytes: number;
  readonly outgoingFrames: number;
  readonly outgoingBytes: number;
}

export interface UpgradeResponseSummary {
  readonly status: number | null;
  readonly kind: "upgrade" | "http-response" | "network-error" | "connection-closed" | "timeout";
  readonly errorCode?: string;
}

interface UpgradeResponseLike {
  readonly statusCode?: number | undefined;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
}

const ALLOWED_CLOUDFLARE_CODES = new Set([
  "1000",
  "1001",
  "1003",
  "1015",
  "1020",
  "1033",
  "1101",
  "1102",
]);

/** Only read fixed error headers and values that cannot contain free-form response text. */
export function safeUpgradeErrorCode(response: UpgradeResponseLike): string | undefined {
  const headerValue = (name: string) => {
    const value = response.headers[name] ?? response.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const cfCode = headerValue("cf-error-code");
  if (typeof cfCode === "string" && ALLOWED_CLOUDFLARE_CODES.has(cfCode)) return `CF_${cfCode}`;
  if (headerValue("cf-mitigated") === "challenge") return "CF_CHALLENGE";
  return undefined;
}

/** Match Lunora's current shard-then-token query when diagnosing its native socket handshake. */
export function upgradeUrl(baseUrl: string | URL, shardKey: string, token: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "wss:") throw new TypeError("The upgrade URL must use wss.");
  url.searchParams.set("shard", shardKey);
  url.searchParams.set("token", token);
  return url;
}

/** Perform one bounded handshake and return no URL, body, headers, or free-form error text. */
export function probeWebSocketUpgrade(
  baseUrl: string | URL,
  shardKey: string,
  token: string,
  timeoutMs = 8_000,
  requestFactory: typeof NodeHttps.request = NodeHttps.request,
): Promise<UpgradeResponseSummary> {
  const url = upgradeUrl(baseUrl, shardKey, token);
  const requestUrl = new URL(url);
  requestUrl.protocol = "https:";
  const key = NodeCrypto.randomBytes(16).toString("base64");
  return new Promise((resolve) => {
    let settled = false;
    const request = requestFactory(requestUrl, {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });
    let responseStatus: number | null = null;
    let responseErrorCode: string | undefined;
    const finish = (summary: UpgradeResponseSummary, destroyRequest = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(summary);
      if (destroyRequest) request.destroy();
    };
    const deadline = setTimeout(() => {
      finish(
        responseStatus === null
          ? { status: null, kind: "timeout" }
          : {
              status: responseStatus,
              kind: "http-response",
              ...(responseErrorCode === undefined ? {} : { errorCode: responseErrorCode }),
            },
        true,
      );
    }, timeoutMs);
    request.once("error", () =>
      finish(
        responseStatus === null
          ? { status: null, kind: "network-error" }
          : {
              status: responseStatus,
              kind: "http-response",
              ...(responseErrorCode === undefined ? {} : { errorCode: responseErrorCode }),
            },
      ),
    );
    request.once("close", () =>
      finish(
        responseStatus === null
          ? { status: null, kind: "connection-closed" }
          : {
              status: responseStatus,
              kind: "http-response",
              ...(responseErrorCode === undefined ? {} : { errorCode: responseErrorCode }),
            },
      ),
    );
    request.once("response", (response) => {
      responseStatus = response.statusCode ?? null;
      responseErrorCode = safeUpgradeErrorCode(response);
      const finishResponse = () =>
        finish({
          status: responseStatus,
          kind: "http-response",
          ...(responseErrorCode === undefined ? {} : { errorCode: responseErrorCode }),
        });
      response.once("end", finishResponse);
      response.once("close", finishResponse);
      response.once("error", finishResponse);
      response.resume();
    });
    request.once("upgrade", (response, socket) => {
      const status = response.statusCode ?? 101;
      const errorCode = safeUpgradeErrorCode(response);
      finish({ status, kind: "upgrade", ...(errorCode === undefined ? {} : { errorCode }) });
      socket.once("error", () => {});
      socket.destroy();
    });
    request.end();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof Error) return error as unknown as Record<string, unknown>;
  return isRecord(error) ? error : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : undefined;
}

function safeName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
    ? value
    : undefined;
}

function safeStatus(record: Record<string, unknown>): number | undefined {
  const status = record.statusCode ?? record.status;
  return typeof status === "number" &&
    Number.isSafeInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

/** Summarize only safe class/code/status fields; error messages can contain URLs or credentials. */
export function safeSocketErrorKind(error: unknown): string {
  const causes: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = errorRecord(current);
    if (record === undefined || seen.has(record)) break;
    seen.add(record);
    causes.push(record);
    current = "error" in record ? record.error : "cause" in record ? record.cause : undefined;
    if (current === undefined || current === null) break;
  }
  if (causes.length === 0) return "unknown error";

  const status = causes.map(safeStatus).find((value) => value !== undefined);
  const code = causes.map((cause) => safeCode(cause.code)).find((value) => value !== undefined);
  if (status !== undefined) return code === undefined ? `HTTP_${status}` : `HTTP_${status}:${code}`;
  if (code !== undefined) return code;
  for (const cause of causes) {
    const name = safeName(cause.name);
    if (name !== undefined) return name;
  }
  return "unknown error";
}

function readyStateName(readyState: number): string {
  switch (readyState) {
    case 0:
      return "connecting";
    case 1:
      return "open";
    case 2:
      return "closing";
    case 3:
      return "closed";
    default:
      return "unknown";
  }
}

/** Keep failure output useful without including the socket URL, close reason, or frame payload. */
export function formatConnectionDiagnostics(
  diagnostics: ReadonlyArray<ConnectionDiagnostic>,
): string {
  if (diagnostics.length === 0) return "none";
  return diagnostics
    .map((diagnostic) => {
      const closes =
        diagnostic.closeEvents
          .map(({ code, count, wasClean }) => `${code}x${count}${wasClean ? " clean" : " unclean"}`)
          .join(",") || "none";
      const errors =
        diagnostic.socketErrors.map(({ kind, count }) => `${kind}x${count}`).join(",") || "none";
      const ready = diagnostic.readyStates.map(readyStateName).join(",") || "none";
      return `${diagnostic.levelId}{open=${diagnostic.opens},close=${diagnostic.closes}[${closes}],ready=${ready},error=[${errors}],frames=${diagnostic.outgoingFrames}/${diagnostic.incomingFrames},bytes=${diagnostic.outgoingBytes}/${diagnostic.incomingBytes}}`;
    })
    .join("; ");
}
