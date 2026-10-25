import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

const URL_QUERY_ATTRIBUTES = new Set(["url.query"]);
const FULL_URL_ATTRIBUTES = new Set([
  "http.request.url",
  "http.target",
  "http.url",
  "request.url",
  "url",
  "url.full",
  "url.original",
]);
const URL_IN_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu;

function redactQuery(value: string): string {
  return value.length === 0 ? value : "[REDACTED]";
}

/** Keeps URL routing metadata while dropping query and fragment contents. */
export function scrubTraceUrl(value: string): string {
  let redacted = value;
  const schemeSeparator = redacted.indexOf("://");
  const authorityStart =
    schemeSeparator < 0 ? (redacted.startsWith("//") ? 2 : -1) : schemeSeparator + 3;
  if (authorityStart >= 0) {
    const authorityEnd = redacted.slice(authorityStart).search(/[/?#]/u);
    const end = authorityEnd < 0 ? redacted.length : authorityStart + authorityEnd;
    const userInfoEnd = redacted.lastIndexOf("@", end);
    if (userInfoEnd >= authorityStart) {
      redacted = `${redacted.slice(0, authorityStart)}[REDACTED]${redacted.slice(userInfoEnd)}`;
    }
  }
  const queryStart = redacted.indexOf("?");
  const fragmentStart = redacted.indexOf("#");
  const suffixStart =
    queryStart < 0
      ? fragmentStart
      : fragmentStart < 0
        ? queryStart
        : Math.min(queryStart, fragmentStart);
  return suffixStart < 0 ? redacted : redacted.slice(0, suffixStart);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scrubAttributeValue(key: string, value: unknown, seen = new WeakSet<object>()): unknown {
  const normalizedKey = key.toLowerCase();
  if (typeof value === "string") {
    if (URL_QUERY_ATTRIBUTES.has(normalizedKey)) return redactQuery(value);
    if (FULL_URL_ATTRIBUTES.has(normalizedKey)) return scrubTraceUrl(value);
    return value;
  }
  if (URL_QUERY_ATTRIBUTES.has(normalizedKey) || FULL_URL_ATTRIBUTES.has(normalizedKey)) {
    return "[REDACTED]";
  }
  return scrubNestedValue(value, seen);
}

function scrubNestedValue(value: unknown, seen: WeakSet<object>): unknown {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return "[CIRCULAR]";

  seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((entry) => {
      const next = scrubNestedValue(entry, seen);
      if (next !== entry) changed = true;
      return next;
    });
    seen.delete(value);
    return changed ? entries : value;
  }

  const entries: Record<string, unknown> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(value)) {
    const next = scrubAttributeValue(key, entry, seen);
    entries[key] = next;
    if (next !== entry) changed = true;
  }
  seen.delete(value);
  return changed ? entries : value;
}

/** Scrubs credential query values at any nested OTLP attribute shape. */
export function scrubTraceAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const scrubbed: Record<string, unknown> = {};
  const seen = new WeakSet<object>([attributes]);
  let changed = false;
  for (const [key, value] of Object.entries(attributes)) {
    const next = scrubAttributeValue(key, value, seen);
    scrubbed[key] = next;
    if (next !== value) changed = true;
  }
  seen.delete(attributes);
  return changed ? scrubbed : attributes;
}

/** Scrubs credential-bearing URLs embedded in exported exception text. */
function redactUrlsInText(value: string): string {
  return value.replace(URL_IN_TEXT, scrubTraceUrl);
}

function scrubError(value: unknown, seen = new WeakSet<object>()): Error {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "object" &&
          value !== null &&
          "message" in value &&
          typeof value.message === "string"
        ? value.message
        : String(value);

  let cause: Error | undefined;
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    if ("cause" in value && value.cause !== undefined) cause = scrubError(value.cause, seen);
  }

  const error = new Error(redactUrlsInText(message), cause ? { cause } : undefined);
  if (value instanceof Error) {
    error.name = value.name;
    if (value.stack) error.stack = redactUrlsInText(value.stack);
  } else if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    error.name = value.name;
  }
  return error;
}

function scrubExit(exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> {
  if (Exit.isSuccess(exit)) return exit;
  return Exit.failCause(
    Cause.fromReasons(
      exit.cause.reasons.map((reason) => {
        if (Cause.isFailReason(reason)) return Cause.makeFailReason(scrubError(reason.error));
        if (Cause.isDieReason(reason)) return Cause.makeDieReason(scrubError(reason.defect));
        return reason;
      }),
    ),
  );
}

function scrubLinks(links: ReadonlyArray<Tracer.SpanLink>): ReadonlyArray<Tracer.SpanLink> {
  let scrubbed: Array<Tracer.SpanLink> | undefined;
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]!;
    const attributes = scrubTraceAttributes(link.attributes);
    if (attributes === link.attributes) continue;
    scrubbed ??= links.slice();
    scrubbed[index] = { ...link, attributes };
  }
  return scrubbed ?? links;
}

/** Wraps an OTLP tracer so URL credentials are removed before any SDK export. */
export function withTraceUrlScrubbing(delegate: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span({ ...options, links: [...scrubLinks(options.links ?? [])] });
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => attribute(key, scrubAttributeValue(key, value));

      const event = span.event.bind(span);
      span.event = (name, startTime, attributes) =>
        event(name, startTime, attributes ? { ...scrubTraceAttributes(attributes) } : attributes);

      const addLinks = span.addLinks.bind(span);
      span.addLinks = (links) => addLinks(scrubLinks(links));

      const end = span.end.bind(span);
      span.end = (endTime, exit) => end(endTime, scrubExit(exit));
      return span;
    },
    ...(delegate.context ? { context: delegate.context.bind(delegate) } : {}),
  });
}
