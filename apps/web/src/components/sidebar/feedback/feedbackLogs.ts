/**
 * Recent console warnings and errors, kept for the feedback button's "Attach
 * logs" option. The web app has no client-side log buffer of its own, so this
 * wraps console.warn/error and listens for uncaught errors and rejections,
 * holding the last MAX_ENTRIES lines in memory. Nothing leaves the page unless
 * the user sends feedback with logs attached.
 */

const MAX_ENTRIES = 200;
const MAX_ENTRY_LENGTH = 2_000;

export type FeedbackLogLevel = "warn" | "error";

export class LogRingBuffer {
  private readonly entries: string[] = [];
  private next = 0;

  constructor(private readonly capacity: number) {}

  push(entry: string): void {
    if (this.entries.length < this.capacity) {
      this.entries.push(entry);
    } else {
      this.entries[this.next] = entry;
    }
    this.next = (this.next + 1) % this.capacity;
  }

  /** Oldest first. */
  snapshot(): string[] {
    if (this.entries.length < this.capacity) return [...this.entries];
    return [...this.entries.slice(this.next), ...this.entries.slice(0, this.next)];
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatLogEntry(
  level: FeedbackLogLevel,
  values: readonly unknown[],
  at: Date,
): string {
  const text = values.map(formatValue).join(" ");
  const clipped =
    text.length > MAX_ENTRY_LENGTH ? `${text.slice(0, MAX_ENTRY_LENGTH)}… (truncated)` : text;
  return `${at.toISOString()} [${level}] ${clipped}`;
}

const buffer = new LogRingBuffer(MAX_ENTRIES);
let installed = false;

function record(level: FeedbackLogLevel, values: readonly unknown[]): void {
  try {
    buffer.push(formatLogEntry(level, values, new Date()));
  } catch {
    // Logging must never throw into the caller.
  }
}

/** Starts capturing. Idempotent; call once at module load of the feedback UI. */
export function installFeedbackLogCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      record(level, values);
      original(...values);
    };
  }
  window.addEventListener("error", (event) => {
    record("error", ["Uncaught", event.error ?? event.message]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    record("error", ["Unhandled rejection", event.reason]);
  });
}

export function readFeedbackLogs(): string {
  const entries = buffer.snapshot();
  return entries.length > 0 ? entries.join("\n") : "No console warnings or errors captured.";
}
