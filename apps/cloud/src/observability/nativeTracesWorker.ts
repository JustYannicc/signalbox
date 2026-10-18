import { BodyRefused, encodingOf, readBody } from "./nativeTracesBody.ts";
import { filterTraces } from "./nativeTracesFilter.ts";

/**
 * The trace receiver Worker (#680): the one way traces reach Sentry. Workers'
 * native traces (as their observability destination) and the clients' traces
 * (#866, through the cloud) are OTLP/JSON exports to `POST /v1/traces`, with
 * `Authorization: Bearer <TRACE_EXPORT_TOKEN>`. Each export is rebuilt by
 * `nativeTracesFilter.ts` and sent on before the answer, so a 200 means Sentry
 * took it. Answers are fixed text: nothing from the export or from Sentry is
 * echoed, logged or forwarded beyond what the filter keeps. This Worker must
 * not trace itself, or its own spans would loop back here.
 */

export interface NativeTracesEnv {
  readonly SENTRY_DSN: string;
  readonly TRACE_EXPORT_TOKEN: string;
  readonly SIGNALBOX_STAGE: string;
  readonly APP_VERSION: string;
}

export type Fetch = (request: Request) => Promise<Response>;

export const TRACES_PATH = "/v1/traces";

const text = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
const accepted = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

const REFUSED: Record<BodyRefused["status"], string> = {
  400: "malformed trace export",
  413: "trace export too large",
  415: "unsupported trace export encoding",
};

export const handleTraceExport = async (
  request: Request,
  env: NativeTracesEnv,
  send: Fetch,
): Promise<Response> => {
  if (!authorized(request.headers.get("authorization"), env.TRACE_EXPORT_TOKEN)) {
    return text(401, "unauthorized");
  }
  if (new URL(request.url).pathname !== TRACES_PATH) return text(404, "not found");
  if (request.method !== "POST") return text(405, "method not allowed", { allow: "POST" });

  const encoding = encodingOf(request.headers.get("content-encoding"));
  if (encoding instanceof BodyRefused) return text(415, REFUSED[415]);
  const body = await readBody(request, encoding);
  if (body instanceof BodyRefused) return text(body.status, REFUSED[body.status]);
  // Cloudflare checks a destination with an empty export first.
  if (body.trim() === "") return accepted();
  if (!isJson(request.headers.get("content-type"))) return text(415, REFUSED[415]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text(400, REFUSED[400]);
  }
  const traces = filterTraces(parsed, { stage: env.SIGNALBOX_STAGE, version: env.APP_VERSION });
  if (traces === null) return text(400, REFUSED[400]);
  if (traces.resourceSpans.length === 0) return accepted();

  const sentry = sentryTraces(env.SENTRY_DSN);
  if (sentry === null) return text(500, "trace export not configured");
  try {
    const response = await send(
      new Request(sentry.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sentry-auth": sentry.auth },
        body: JSON.stringify(traces),
      }),
    );
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? accepted() : text(502, "trace export failed upstream");
  } catch {
    return text(502, "trace export failed upstream");
  }
};

const isJson = (header: string | null) =>
  (header ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

/** Bearer auth in constant time. An unset token refuses everyone. */
const authorized = (header: string | null, token: string): boolean => {
  if (token.length === 0 || header === null) return false;
  const match = /^Bearer (.+)$/i.exec(header);
  if (match === null) return false;
  const given = new TextEncoder().encode(match[1] ?? "");
  const expected = new TextEncoder().encode(token);
  let difference = given.length ^ expected.length;
  for (let index = 0; index < expected.length; index++) {
    difference |= (given[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
};

/**
 * Sentry's OTLP traces endpoint for the project a DSN names
 * (https://docs.sentry.io/product/drains/cloudflare/), with the DSN's public
 * key, which only lets one send to that project. Null without a usable DSN.
 */
export const sentryTraces = (dsn: string): { url: string; auth: string } | null => {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  // `/<project>`, or `/<path>/<project>` for a Sentry served under a path.
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const project = segments.pop();
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (project === undefined || !/^\d+$/.test(project) || !/^[0-9a-f]+$/i.test(url.username)) {
    return null;
  }
  const base = segments.map((segment) => `/${segment}`).join("");
  return {
    url: `${url.protocol}//${url.host}${base}/api/${project}/integration/otlp/v1/traces`,
    auth: `sentry sentry_key=${url.username}`,
  };
};

export default {
  // @effect-diagnostics-next-line globalFetch:off - the Workers runtime's own fetch.
  fetch: (request, env) => handleTraceExport(request, env, (outgoing) => fetch(outgoing)),
} satisfies ExportedHandler<NativeTracesEnv>;
