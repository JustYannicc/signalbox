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
