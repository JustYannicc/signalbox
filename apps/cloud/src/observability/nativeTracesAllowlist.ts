import { WsRpcGroup } from "@t3tools/contracts";
import { CLIENT_ISSUE_CODES, CLIENT_ISSUE_RELEASE_PATTERN } from "@t3tools/contracts/clientIssues";
import { CLIENT_ACTION_IDS } from "@t3tools/contracts/clientActionTiming";

/**
 * What may leave Cloudflare's native Worker traces for Sentry (#680). Every
 * entry is reviewed: a key's value is a bounded number, a boolean, a member
 * of a fixed set, or a validated id, never free text. Anything not listed is
 * dropped. Key and operation names follow Cloudflare's catalog:
 * https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/
 */

export type AttributeRule =
  /** A non-negative safe integer: counts and sizes. */
  | { readonly type: "count" }
  /** A non-negative finite number, integer or double: timings. */
  | { readonly type: "measure" }
  | { readonly type: "httpStatus" }
  | { readonly type: "bool" }
  | { readonly type: "enum"; readonly values: ReadonlySet<string> }
  /** A 16-hex-digit span id, for linking an RPC callee to its caller. */
  | { readonly type: "spanId" }
  /** One of our own ids, in its exact generated format. */
  | { readonly type: "id"; readonly format: RegExp };

const RPC_METHODS = new Set(WsRpcGroup.requests.keys());
const RPC_SPAN_NAMES = [...RPC_METHODS].flatMap((method) => [
  method,
  `RpcClient.${method}`,
  `RpcServer.${method}`,
]);

const count = { type: "count" } as const;
const measure = { type: "measure" } as const;
const bool = { type: "bool" } as const;
const oneOf = (...values: ReadonlyArray<string>) =>
  ({ type: "enum", values: new Set(values) }) as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** WorkOS ids: a prefix and a ULID in Crockford base32. */
const workos = (prefix: string) =>
  ({ type: "id", format: new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`) }) as const;
const uuid = { type: "id", format: new RegExp(`^${UUID}$`) } as const;
const clientRelease = {
  type: "id",
  format: CLIENT_ISSUE_RELEASE_PATTERN,
} as const;
const environmentId = { type: "id", format: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ } as const;
const clientIssueSources = oneOf("ui", "rpc", "subscription", "exception", "console", "react");
const clientIssueClients = oneOf("web", "desktop", "mobile");
const clientActionEntryPoints = oneOf(
  "click",
  "key",
  "palette",
  "menu",
  "gesture",
  "touch",
  "accessibility",
  "native_menu",
);
const clientActionClients = oneOf("web", "desktop", "ios", "android");
const clientActionOperatingSystems = oneOf(
  "windows",
  "macos",
  "linux",
  "ios",
  "android",
  "unknown",
);
const clientActionDevices = oneOf("phone", "tablet", "computer", "unknown");
const clientActionIds = oneOf(...CLIENT_ACTION_IDS);
const clientActionConnections = oneOf("online", "reconnecting", "offline");
const clientActionModes = oneOf("cloud", "local");
const clientActionPaths = oneOf("optimistic", "pending", "local", "server");
const clientActionMethods = oneOf(
  "browser_frame_estimate",
  "native_frame_estimate",
  "rn_event_mount",
  "native_presented",
  "commit_only",
);
const clientActionOutcomes = oneOf("success", "rejected", "abandoned", "no_feedback", "background");

/**
 * The shared dimensions (`evlogWorkers.ts` `CloudFields`) the clients stamp
 * on their spans (#866), so a client trace joins its cloud work. Ids only, in
 * the exact format we generate: a turn is the cloud's `run:<thread>:<n>` or a uuid.
 */
export const DIMENSIONS: ReadonlyMap<string, AttributeRule> = new Map<string, AttributeRule>([
  ["person.id", workos("user")],
  ["org.id", workos("org")],
  ["folder.id", uuid],
  ["thread.id", uuid],
  ["turn.id", { type: "id", format: new RegExp(`^(?:run:${UUID}:[0-9]{1,9}|${UUID})$`) }],
  ["automation.id", uuid],
]);

const HTTP_METHODS = oneOf(
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "CONNECT",
  "TRACE",
);

const HANDLER_TYPES = oneOf(
  "fetch",
  "scheduled",
  "queue",
  "alarm",
  "email",
  "tail",
  "trace",
  "jsrpc",
);

const FAAS_TRIGGERS = oneOf("http", "timer", "pubsub", "datasource", "other");

export const SPAN_ATTRIBUTES: ReadonlyMap<string, AttributeRule> = new Map<string, AttributeRule>([
  ...DIMENSIONS,
  ["rpc.method", { type: "enum", values: RPC_METHODS }],
  ["client.issue.code", { type: "enum", values: new Set(CLIENT_ISSUE_CODES) }],
  ["client.issue.severity", oneOf("error", "warning")],
  ["client.issue.source", clientIssueSources],
  ["client.issue.duration_ms", measure],
  ["client.release", clientRelease],
  ["client.type", clientIssueClients],
  ["client.action.id", clientActionIds],
  ["client.action.entry_point", clientActionEntryPoints],
  ["client.action.client", clientActionClients],
  ["client.action.os", clientActionOperatingSystems],
  ["client.action.device", clientActionDevices],
  ["client.action.connection", clientActionConnections],
  ["client.action.mode", clientActionModes],
  ["client.action.path", clientActionPaths],
  ["client.action.feedback_method", clientActionMethods],
  ["client.action.desired_state_method", clientActionMethods],
  ["client.action.outcome", clientActionOutcomes],
  ["client.action.handler_delay_ms", measure],
  ["client.action.feedback_ms", measure],
  ["client.action.desired_state_ms", measure],
  ["client.action.event_timing_ms", measure],
  ["client.action.event_timing_method", oneOf("browser_event_timing", "rn_event_mount")],
  ["client.action.event_timing_status", oneOf("observed", "no_entry", "unavailable", "cancelled")],
  ["client.action.acknowledgement_ms", measure],
  ["client.action.convergence_ms", measure],
  ["client.action.completion_ms", measure],
  ["environment.id", environmentId],
  // Root spans: what ran and how it went.
  ["faas.trigger", FAAS_TRIGGERS],
  ["cloudflare.handler_type", HANDLER_TYPES],
  ["cloudflare.execution_model", oneOf("stateless", "durableObject", "workflow")],
  [
    "cloudflare.outcome",
    oneOf(
      "ok",
      "exception",
      "exceededCpu",
      "exceededMemory",
      "scriptNotFound",
      "canceled",
      "responseStreamDisconnected",
      "killSwitch",
      "daemonDown",
      "loadShed",
      "unknown",
    ),
  ],
  ["cloudflare.cpu_time_ms", measure],
  ["cloudflare.wall_time_ms", measure],
  ["cloudflare.response.time_to_first_byte_ms", measure],
  ["cloudflare.invocation.sequence.number", count],
  ["cloudflare.queue.batch_size", count],
  ["cloudflare.trace.count", count],
  // HTTP, inbound and outbound: method and status only, never the URL.
  ["http.request.method", HTTP_METHODS],
  ["http.response.status_code", { type: "httpStatus" }],
  ["http.request.body.size", count],
  ["http.response.body.size", count],
  ["url.scheme", oneOf("http", "https")],
  ["network.protocol.name", oneOf("http")],
  ["network.protocol.version", oneOf("1.0", "1.1", "2", "3")],
  // Cache API.
  ["cache.response.success", bool],
  ["cache.response.status_code", { type: "httpStatus" }],
  ["cache.response.body.size", count],
  // D1: the counters, never the query, bindings or bookmarks.
  ["cloudflare.d1.response.rows_read", count],
  ["cloudflare.d1.response.rows_written", count],
  ["cloudflare.d1.response.changes", count],
  ["cloudflare.d1.response.size_after", count],
  ["cloudflare.d1.response.sql_duration_ms", measure],
  ["cloudflare.d1.response.total_attempts", count],
  ["cloudflare.d1.response.served_by_primary", bool],
  ["cloudflare.d1.response.changed_db", bool],
  ["db.operation.batch.size", count],
  // Durable Object storage: the counters, never the query, bindings or keys.
  ["cloudflare.durable_object.response.rows_read", count],
  ["cloudflare.durable_object.response.rows_written", count],
  ["cloudflare.durable_object.response.db_size", count],
  ["cloudflare.durable_object.kv.query.keys.count", count],
  ["cloudflare.durable_object.kv.response.deleted_count", count],
  // KV: counts and sizes, never keys, prefixes, cursors or metadata.
  ["cloudflare.kv.query.keys.count", count],
  ["cloudflare.kv.query.payload.size", count],
  ["cloudflare.kv.response.size", count],
  ["cloudflare.kv.response.returned_rows", count],
  ["cloudflare.kv.response.list_complete", bool],
  // R2: success and sizes, never keys, buckets, metadata or error messages.
  ["cloudflare.r2.response.success", bool],
  ["cloudflare.r2.response.size", count],
  ["cloudflare.r2.request.size", count],
  ["cloudflare.r2.response.returned_objects", count],
  ["cloudflare.r2.response.truncated", bool],
  // RPC between our own Workers and Durable Objects.
  ["jsrpc.operation", oneOf("call", "getProperty")],
  ["jsrpc.caller_span_id", { type: "spanId" }],
]);

/** Known Cloudflare operations and exact RPC templates; other names become `worker.operation`. */
export const OPERATIONS: ReadonlySet<string> = new Set([
  ...RPC_SPAN_NAMES,
  "client.action",
  "client.issue",
  "client.issue.intake",
  "fetch",
  "cache_put",
  "cache_match",
  "cache_delete",
  "d1_batch",
  "d1_exec",
  "d1_first",
  "d1_run",
  "d1_all",
  "d1_raw",
  "browser_rendering_fetch",
  "kv_get",
  "kv_getWithMetadata",
  "kv_put",
  "kv_delete",
  "kv_list",
  "r2_head",
  "r2_get",
  "r2_put",
  "r2_list",
  "r2_delete",
  "r2_createMultipartUpload",
  "r2_uploadPart",
  "r2_abortMultipartUpload",
  "r2_completeMultipartUpload",
  "durable_object_subrequest",
  "durable_object_storage_exec",
  "durable_object_storage_getDatabaseSize",
  "durable_object_storage_kv_get",
  "durable_object_storage_kv_put",
  "durable_object_storage_kv_delete",
  "durable_object_storage_kv_list",
  "durable_object_storage_get",
  "durable_object_storage_put",
  "durable_object_storage_delete",
  "durable_object_storage_list",
  "durable_object_storage_deleteAll",
  "durable_object_alarms_getAlarm",
  "durable_object_alarms_setAlarm",
  "durable_object_alarms_deleteAlarm",
  "jsRpcCall",
  "images_output",
  "images_info",
  "reply_email",
  "forward_email",
  "send_email",
  "queue_send",
  "queue_sendBatch",
  "ratelimit_run",
]);

/**
 * Who a trace may say it came from: our Workers, by the script names
 * `infra/stage.ts` gives them, and the web and mobile clients (#866). The
 * output names its service with one of these constants, never with the name
 * it arrived with; anything else is `UNKNOWN_SERVICE`.
 */
const SERVICES: ReadonlyArray<readonly [service: string, matches: (name: string) => boolean]> = [
  ["signalbox-cloud", (name) => /^signalbox-cloud(?:-pr-\d{1,6})?$/.test(name)],
  ["signalbox-model-gateway", (name) => /^signalbox-model-gateway(?:-pr-\d{1,6})?$/.test(name)],
  ["t3code-web", (name) => name === "t3code-web"],
  ["t3code-mobile", (name) => name === "t3code-mobile"],
  ["t3code-desktop", (name) => name === "t3code-desktop"],
];
export const UNKNOWN_SERVICE = "signalbox";
export const CLIENT_SERVICES: ReadonlySet<string> = new Set([
  "t3code-web",
  "t3code-mobile",
  "t3code-desktop",
]);

/** Where a trace may say which service it came from, most specific first. */
export const SERVICE_KEYS: ReadonlyArray<string> = [
  "service.name",
  "faas.name",
  "cloudflare.script_name",
];

export const serviceOf = (name: string): string | undefined =>
  SERVICES.find(([, matches]) => matches(name))?.[0];
