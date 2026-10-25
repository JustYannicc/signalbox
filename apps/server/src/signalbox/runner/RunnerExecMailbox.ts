import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ExecReport } from "@signalbox/runner-protocol/ExecProtocol";

const REPORT_HIGH_WATER = 256;
const REPORT_LOW_WATER = 128;

interface PausableOutput {
  readonly pause: () => unknown;
  readonly resume: () => unknown;
}

/** A report queue that pauses native output streams while preserving every report. */
export class RunnerExecMailbox {
  readonly #queue: Queue.Queue<ExecReport, Cause.Done>;
  readonly #paused = new Set<PausableOutput>();
  readonly stream: Stream.Stream<ExecReport>;
  #closed = false;

  constructor(queue: Queue.Queue<ExecReport, Cause.Done>) {
    this.#queue = queue;
    this.stream = Stream.fromQueue(this.#queue).pipe(
      Stream.tap(() => Effect.sync(() => this.#resumeBelowWatermark())),
    );
  }

  offer(report: ExecReport, source?: PausableOutput) {
    if (this.#closed || !Queue.offerUnsafe(this.#queue, report)) return;
    if (
      source !== undefined &&
      !this.#paused.has(source) &&
      Queue.sizeUnsafe(this.#queue) >= REPORT_HIGH_WATER
    ) {
      source.pause();
      this.#paused.add(source);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#resumeAll();
    Queue.endUnsafe(this.#queue);
  }

  #resumeBelowWatermark() {
    if (Queue.sizeUnsafe(this.#queue) <= REPORT_LOW_WATER) this.#resumeAll();
  }

  #resumeAll() {
    const paused = [...this.#paused];
    // A resume callback may re-enter close; clear first so it cannot resume twice.
    this.#paused.clear();
    for (const source of paused) source.resume();
  }
}
