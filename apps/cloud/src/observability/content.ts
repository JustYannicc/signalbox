/**
 * Wide events say how much work was done, never what it said (#284): sizes,
 * counts, kinds and timings, never message text, prompts, file contents or
 * tool payloads. Fields are chosen to hold none, and this is the net behind
 * them: evlog's redaction runs it on every event before any drain sees it.
 */

/** Keys whose text is content, at any depth. Numbers under them (token counts) stay. */
export const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "prompts",
  "instructions",
  "content",
  "text",
  "body",
  "payload",
  "input",
  "output",
  "arguments",
  // Effect and evlog serialize failures here, including rejected input.
  "error",
  "cause",
  "message",
  "stack",
  // URLs can contain single-use OAuth codes as well as reusable credentials.
  "url",
  "url.full",
  "url.query",
  "http.url",
  "query_string",
  "queryString",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "ticket",
  "api_key",
  "client_secret",
]);

export const REDACTED = "[REDACTED]";

// Only these fixed classes may survive as Sentry issue types, never provider text.
const TURN_FAILURE_CLASSES = new Set([
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);

/** What an event keeps if redacting it fails: enough to find it, nothing more. */
const IDENTITY_KEYS = new Set([
  "timestamp",
  "level",
  "service",
  "environment",
  "version",
  "action",
  "requestId",
  "traceId",
  "spanId",
  "status",
  "duration",
  "durationMs",
]);

/** Replaces every string under a content-shaped key, in place. */
export const redactContent = (event: Record<string, unknown>): void => {
  const seen = new WeakMap<object, boolean>();
  const visit = (node: unknown, redacting: boolean): unknown => {
    if (typeof node === "string") return redacting ? REDACTED : node;
    if (typeof node !== "object" || node === null) return node;
    // An alias reached through content must upgrade an earlier metadata visit.
    if (seen.has(node) && (seen.get(node) || !redacting)) return node;
    seen.set(node, redacting);
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries())
        node[index] = visit(entry, seen.get(node) === true);
      return node;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      record[key] = visit(value, seen.get(node) === true || CONTENT_KEYS.has(key));
    }
    return node;
  };
  try {
    // Hook credentials are path segments, including on rejected requests.
    if (typeof event.path === "string" && event.path.startsWith("/api/hooks/")) {
      event.path = "/api/hooks/:userId/:hookId/[REDACTED]";
    }
    visit(event, false);
    const turn = event.turn;
    if (event.action === "turn" && typeof turn === "object" && turn !== null) {
      const failureClass = (turn as Record<string, unknown>).failureClass;
      if (typeof failureClass === "string" && TURN_FAILURE_CLASSES.has(failureClass)) {
        event.error = { name: `TurnFailure.${failureClass}`, message: REDACTED };
      }
    }
  } catch {
    // evlog drains the event anyway when this throws: fail closed instead.
    for (const key of Object.keys(event)) if (!IDENTITY_KEYS.has(key)) delete event[key];
    event.redactionFailed = true;
  }
};
