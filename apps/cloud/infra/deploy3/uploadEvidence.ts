// @effect-diagnostics nodeBuiltinImport:off - Dispatch retains exact HTTP upload responses before the SDK decodes success or failure.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { sha256 } from "../workerStartup/payload.ts";
import { clockMillis, isoAt } from "./platform.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function scriptUpload(response: HttpClientResponse.HttpClientResponse) {
  const url = new URL(response.request.url);
  if (url.hostname !== "api.cloudflare.com") return false;
  const script =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/(?:scripts\/[^/]+|dispatch\/namespaces\/[^/]+\/scripts\/[^/]+)(\/versions)?$/.exec(
      url.pathname,
    );
  return script !== null && response.request.method === (script[1] ? "POST" : "PUT");
}

function startupTimings(
  value: unknown,
  path = "$",
  found: { path: string; value: unknown; unit: "ms" | null }[] = [],
) {
  if (value === null || typeof value !== "object") return found;
  for (const [name, child] of Object.entries(value)) {
    const location = `${path}.${name}`;
    if (/startup.*(?:time|cpu)|(?:time|cpu).*startup/i.test(name))
      found.push({ path: location, value: child, unit: /(?:_ms|Ms)$/.test(name) ? "ms" : null });
    if (child !== null && typeof child === "object") startupTimings(child, location, found);
  }
  return found;
}

/** The original cached body stays available to the SDK, including non-2xx upload errors. */
export function retainScriptUploadResponses(
  client: HttpClient.HttpClient,
  directory: string,
  attemptId: string,
) {
  let sequence = 0;
  return HttpClient.transformResponse(client, (request) =>
    request.pipe(
      Effect.tap((response) => {
        if (!scriptUpload(response)) return Effect.void;
        const number = ++sequence;
        return Effect.gen(function* () {
          const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.orDie));
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
            const name = `${attemptId}-${String(number).padStart(3, "0")}`;
            const rawFile = `${name}.response`;
            await NodeFSP.writeFile(NodePath.join(directory, rawFile), bytes, {
              flag: "wx",
              mode: 0o600,
            });
            const body = decodeJson(Buffer.from(bytes).toString("utf8"));
            const timings = startupTimings(body._tag === "Some" ? body.value : null);
            const timingHeaders = Object.fromEntries(
              Object.entries(response.headers).filter(([name]) => /startup/i.test(name)),
            );
            const record = {
              schema: "signalbox/script-upload-response/v1",
              attemptId,
              sequence: number,
              receivedAt: isoAt(clockMillis()),
              method: response.request.method,
              path: new URL(response.request.url).pathname,
              httpStatus: response.status,
              response: { file: rawFile, bytes: bytes.byteLength, sha256: sha256(bytes) },
              startupTiming: {
                status:
                  timings.length || Object.keys(timingHeaders).length ? "reported" : "unavailable",
                values: timings,
                headers: timingHeaders,
              },
            };
            await NodeFSP.writeFile(
              NodePath.join(directory, `${name}.json`),
              `${encodeJson(record)}\n`,
              { flag: "wx", mode: 0o600 },
            );
          });
        });
      }),
    ),
  );
}

/** Merge this client into compiled stack services so reconciliation uses the same observer. */
export const uploadEvidenceLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const plan = yield* Config.String("DEPLOY3_PLAN_FILE").pipe(Effect.orDie);
    const attempt = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
    return retainScriptUploadResponses(
      client,
      NodePath.join(NodePath.dirname(plan), "script-uploads"),
      attempt,
    );
  }),
);
