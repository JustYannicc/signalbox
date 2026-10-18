import {
  type AttributeRule,
  CLIENT_SERVICES,
  DIMENSIONS,
  OPERATIONS,
  SERVICE_KEYS,
  SPAN_ATTRIBUTES,
  UNKNOWN_SERVICE,
  serviceOf,
} from "./nativeTracesAllowlist.ts";

/**
 * Rebuilds an OTLP/JSON trace export from scratch, keeping only what
 * `nativeTracesAllowlist.ts` lets through (#680). Nothing is passed along as
 * it arrived: names are constants, strings are members of fixed sets, numbers
 * are bounded, ids are validated hex. Events, links, trace state, status
 * messages, scopes, schema URLs and every unlisted attribute are dropped.
 */

export type OtlpValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number };

export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpValue;
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind?: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: ReadonlyArray<OtlpAttribute>;
  readonly status?: { readonly code: number };
}

export interface OtlpTraces {
  readonly resourceSpans: ReadonlyArray<{
    readonly resource: { readonly attributes: ReadonlyArray<OtlpAttribute> };
    readonly scopeSpans: ReadonlyArray<{
      readonly scope: { readonly name: string };
      readonly spans: ReadonlyArray<OtlpSpan>;
    }>;
  }>;
}

/** Deploy facts from the receiver's own env, never from the export. */
export interface TrustedResource {
  readonly stage: string;
  readonly version: string;
}

export const SCOPE_NAME = "signalbox.traces";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arrayOf = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

/**
 * The filtered export, or null when the body isn't an export at all. An
 * export with nothing worth keeping comes back with no `resourceSpans`.
 */
export const filterTraces = (input: unknown, trusted: TrustedResource): OtlpTraces | null => {
  if (!isObject(input)) return null;
  if (input.resourceSpans !== undefined && !Array.isArray(input.resourceSpans)) return null;
  const resourceSpans: Array<OtlpTraces["resourceSpans"][number]> = [];
  for (const entry of arrayOf(input.resourceSpans)) {
    if (!isObject(entry)) continue;
    const sources = arrayOf(entry.scopeSpans).flatMap((scope) =>
      isObject(scope) ? arrayOf(scope.spans).filter(isObject) : [],
    );
    const resource = isObject(entry.resource) ? entry.resource : {};
    const service = serviceFrom(resource, sources);
    const spans = sources.flatMap((span) => {
      const kept = filterSpan(span, service);
      return kept === null ? [] : [kept];
    });
    if (spans.length === 0) continue;
    resourceSpans.push({
      resource: { attributes: resourceAttributes(service, resource, trusted) },
      scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
    });
  }
  return { resourceSpans };
};

const filterSpan = (span: Json, service: string): OtlpSpan | null => {
  if (carriesContent(span)) return null;
  const traceId = hexId(span.traceId, 32);
  const spanId = hexId(span.spanId, 16);
  const start = nanos(span.startTimeUnixNano);
  const end = nanos(span.endTimeUnixNano);
  if (traceId === null || spanId === null || start === null || end === null) return null;
  if (start === 0n || end < start) return null;
  // Some exporters mark a root with an all-zero parent rather than none.
  const parent = span.parentSpanId;
  const root = parent === undefined || (typeof parent === "string" && /^0*$/.test(parent));
  const parentSpanId = root ? undefined : hexId(parent, 16);
  if (parentSpanId === null) return null;

  const attributes = keptAttributes(span.attributes, SPAN_ATTRIBUTES);
  const kind = enumNumber(span.kind, KINDS);
  const code = isObject(span.status) ? enumNumber(span.status.code, STATUS_CODES) : undefined;
  return {
    traceId,
    spanId,
    ...(parentSpanId !== undefined && { parentSpanId }),
    name: spanName(span.name, kind, attributes, service),
    ...(kind !== undefined && { kind }),
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes,
    ...(code !== undefined && { status: { code } }),
  };
};

// Binding attributes from Cloudflare are counts today. Refuse a future exporter
// that puts actual values there, or attaches message text, rather than exporting
// any part of that span.
const carriesContent = (span: Json): boolean => {
  const attributes = [
    ...arrayOf(span.attributes),
    ...arrayOf(span.events).flatMap((event) => (isObject(event) ? arrayOf(event.attributes) : [])),
  ];
  if (
    isObject(span.status) &&
    typeof span.status.message === "string" &&
    span.status.message !== ""
  )
    return true;
  return attributes.some((attribute) => {
    if (!isObject(attribute) || typeof attribute.key !== "string" || !isObject(attribute.value))
      return false;
    const { key, value } = attribute;
    if (key.endsWith(".query.bindings")) {
      const count = value.intValue ?? value.doubleValue;
      return !(
        (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
        (typeof count === "string" && /^\d{1,9}$/.test(count))
      );
    }
    return /(?:^|\.)(?:message|content|prompt|completion|body|payload|arguments|stacktrace)$/.test(
      key,
    );
  });
};

/**
 * Lowercase hex at OTLP's full width. Cloudflare sometimes drops an id's
 * leading zeros, so a short id is padded back rather than refused. An
 * all-zero id is invalid in OTLP.
 */
const hexId = (value: unknown, width: 16 | 32): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > width) return null;
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  const id = value.toLowerCase().padStart(width, "0");
  return /^0+$/.test(id) ? null : id;
};

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const nanos = (value: unknown): bigint | null => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_UINT64 ? parsed : null;
};

const KINDS = [
  "SPAN_KIND_UNSPECIFIED",
  "SPAN_KIND_INTERNAL",
  "SPAN_KIND_SERVER",
  "SPAN_KIND_CLIENT",
  "SPAN_KIND_PRODUCER",
  "SPAN_KIND_CONSUMER",
];
const SERVER = 2;
const CLIENT = 3;
const STATUS_CODES = ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"];

/** OTLP/JSON enums are integers, but some exporters send their names. */
const enumNumber = (value: unknown, names: ReadonlyArray<string>): number | undefined => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value < names.length ? value : undefined;
  }
  const index = typeof value === "string" ? names.indexOf(value) : -1;
  return index === -1 ? undefined : index;
};

const stringAttribute = (attributes: ReadonlyArray<OtlpAttribute>, key: string) => {
  const value = attributes.find((attribute) => attribute.key === key)?.value;
  return value !== undefined && "stringValue" in value ? value.stringValue : undefined;
};

/**
 * A fixed name: a handler's kind, a known Cloudflare operation, an HTTP
 * method's, or a generic one. Source names carry paths and arbitrary text
 * (`GET /drive/<file>`), so they're only ever compared, never copied.
 */
const spanName = (
  name: unknown,
  kind: number | undefined,
  attributes: ReadonlyArray<OtlpAttribute>,
  service: string,
): string => {
  const handler = stringAttribute(attributes, "cloudflare.handler_type");
  const trigger = stringAttribute(attributes, "faas.trigger");
  const method = stringAttribute(attributes, "http.request.method");
  if (handler !== undefined || trigger !== undefined) {
    if (handler === "fetch" || trigger === "http") {
      return method === undefined ? "http.server" : `http.server ${method}`;
    }
    return handler === undefined ? "worker.operation" : `worker.${handler}`;
  }
  if (typeof name === "string" && OPERATIONS.has(name)) return name;
  if (method !== undefined && kind === SERVER) return `http.server ${method}`;
  if (method !== undefined && kind === CLIENT) return `http.client ${method}`;
  return CLIENT_SERVICES.has(service) ? "client.operation" : "worker.operation";
};

const keptAttributes = (
  input: unknown,
  rules: ReadonlyMap<string, AttributeRule>,
): Array<OtlpAttribute> => {
  const kept = new Map<string, OtlpValue>();
  for (const attribute of arrayOf(input)) {
    if (!isObject(attribute) || typeof attribute.key !== "string") continue;
    const rule = rules.get(attribute.key);
    if (rule === undefined || kept.has(attribute.key) || !isObject(attribute.value)) continue;
    const value = applyRule(rule, attribute.value);
    if (value !== null) kept.set(attribute.key, value);
  }
  return [...kept].map(([key, value]) => ({ key, value }));
};

const MAX_MEASURE = 1e15;
const applyRule = (rule: AttributeRule, value: Json): OtlpValue | null => {
  switch (rule.type) {
    case "count": {
      const parsed = integer(value.intValue);
      return parsed === null ? null : { intValue: String(parsed) };
    }
    case "httpStatus": {
      const parsed = integer(value.intValue);
      const valid = parsed !== null && parsed >= 100 && parsed <= 599;
      return valid ? { intValue: String(parsed) } : null;
    }
    case "measure": {
      const parsed = integer(value.intValue);
      if (parsed !== null) return { intValue: String(parsed) };
      const double = value.doubleValue;
      const bounded = typeof double === "number" && Number.isFinite(double);
      return bounded && double >= 0 && double <= MAX_MEASURE ? { doubleValue: double } : null;
    }
    case "bool":
      return typeof value.boolValue === "boolean" ? { boolValue: value.boolValue } : null;
    case "enum":
      return typeof value.stringValue === "string" && rule.values.has(value.stringValue)
        ? { stringValue: value.stringValue }
        : null;
    case "spanId": {
      const id = hexId(value.stringValue, 16);
      return id === null ? null : { stringValue: id };
    }
    case "id": {
      const id = value.stringValue;
      return typeof id === "string" && id.length <= 128 && rule.format.test(id)
        ? { stringValue: id }
        : null;
    }
  }
};

/** A non-negative safe integer, from OTLP/JSON's number or decimal-string int64. */
const integer = (value: unknown): number | null => {
  const parsed =
    typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** The first service any of the export's own fields names, as our constant for it. */
const serviceFrom = (resource: Json, spans: ReadonlyArray<Json>): string => {
  for (const attributes of [resource.attributes, ...spans.map((span) => span.attributes)]) {
    for (const attribute of arrayOf(attributes)) {
      if (!isObject(attribute) || !SERVICE_KEYS.includes(String(attribute.key))) continue;
      const value = isObject(attribute.value) ? attribute.value.stringValue : undefined;
      const service = typeof value === "string" ? serviceOf(value) : undefined;
      if (service !== undefined) return service;
    }
  }
  return UNKNOWN_SERVICE;
};

const TRUSTED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/;
/** Our service constant, deploy facts from our own env, and the export's validated id dimensions. */
const resourceAttributes = (service: string, resource: Json, trusted: TrustedResource) => {
  const attributes = keptAttributes(resource.attributes, DIMENSIONS);
  attributes.unshift({ key: "service.name", value: { stringValue: service } });
  if (TRUSTED_VALUE.test(trusted.stage)) {
    for (const key of ["deployment.environment.name", "sentry.environment"]) {
      attributes.push({ key, value: { stringValue: trusted.stage } });
    }
  }
  if (TRUSTED_VALUE.test(trusted.version)) {
    for (const key of ["service.version", "sentry.release"]) {
      attributes.push({ key, value: { stringValue: trusted.version } });
    }
  }
  return attributes;
};
