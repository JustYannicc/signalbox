import { serializeTraceValue } from "./serialize.ts";
import type {
  NodeChildProcessTraceEvent,
  NodeChildProcessTraceOptions,
  NodeChildProcessTraceWriterError,
  TraceChildEventKind,
  TraceTiming,
} from "./types.ts";

export class ChildProcessTraceWriter {
  readonly #record: NodeChildProcessTraceOptions["record"];
  readonly #pending = new Set<Promise<void>>();
  readonly #writerErrors: NodeChildProcessTraceWriterError[] = [];
  #eventSequence = 0;

  constructor(options: Pick<NodeChildProcessTraceOptions, "record">) {
    this.#record = options.record;
  }

  observe(
    processKey: string,
    childId: string,
    eventKind: TraceChildEventKind,
    fields: () => Readonly<Record<string, unknown>>,
  ): void {
    const observedAtWallTimeMs = Date.now();
    const observedAtMonotonicMs = monotonicNow();
    const captureStartedAtWallTimeMs = Date.now();
    const captureStartedAtMonotonicMs = monotonicNow();
    let body: Readonly<Record<string, unknown>>;
    try {
      body = fields();
    } catch (error) {
      body = { observationGap: serializeTraceValue(error) };
      this.addError({ operation: "record", childId, eventKind, error });
    }
    const captureCompletedAtWallTimeMs = Date.now();
    const timing: TraceTiming = {
      observedAtWallTimeMs,
      observedAtMonotonicMs,
      captureStartedAtWallTimeMs,
      captureCompletedAtWallTimeMs,
      captureDurationMs: Math.max(0, monotonicNow() - captureStartedAtMonotonicMs),
    };
    const event = {
      processKey,
      childId,
      sequence: ++this.#eventSequence,
      eventKind,
      timing,
      ...body,
    } as NodeChildProcessTraceEvent;
    try {
      // Hook windows depend on observation order, even while earlier writes await durability.
      const written = this.#record(event);
      let pending: Promise<void>;
      pending = Promise.resolve(written)
        .catch((error: unknown) => {
          this.addError({ operation: "record", childId, eventKind, error });
        })
        .finally(() => this.#pending.delete(pending));
      this.#pending.add(pending);
    } catch (error) {
      this.addError({ operation: "record", childId, eventKind, error });
    }
  }

  addError(error: NodeChildProcessTraceWriterError): void {
    let encoded: unknown;
    try {
      encoded = serializeTraceValue(error.error);
    } catch {
      encoded = { kind: "uncapturable", reason: "error-serialization-failed" };
    }
    this.#writerErrors.push({ ...error, error: encoded });
  }

  track(job: Promise<unknown>, childId: string): void {
    let tracked: Promise<void>;
    tracked = Promise.resolve(job)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.addError({ operation: "capture-output", childId, error });
      })
      .finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  get writerErrors(): readonly NodeChildProcessTraceWriterError[] {
    return this.#writerErrors.map((error) => ({ ...error }));
  }
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
