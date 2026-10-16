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
]);

export const REDACTED = "[REDACTED]";

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
  const seen = new WeakSet<object>();
  const visit = (node: unknown, redacting: boolean): unknown => {
    if (typeof node === "string") return redacting ? REDACTED : node;
    if (typeof node !== "object" || node === null || seen.has(node)) return node;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) node[index] = visit(entry, redacting);
      return node;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      record[key] = visit(value, redacting || CONTENT_KEYS.has(key));
    }
    return node;
  };
  try {
    visit(event, false);
  } catch {
    // evlog drains the event anyway when this throws: fail closed instead.
    for (const key of Object.keys(event)) if (!IDENTITY_KEYS.has(key)) delete event[key];
    event.redactionFailed = true;
  }
};
