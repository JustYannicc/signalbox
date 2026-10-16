import { RECORDING_CHECKOUT_CHARS } from "./RunnerBrowserRecorder.ts";

/**
 * A tab's recording since its last trail step (#587), as batches of rrweb
 * events. It is empty or starts with a full snapshot, so it replays on its
 * own: a new viewer catches up from its last full snapshot, and `cut` hands
 * the whole of it to the trail.
 *
 * Bounded: a full snapshot arriving past `RECORDING_CHECKOUT_CHARS` drops
 * what came before it, and past twice that without one the segment drops
 * everything and waits for the next (the page takes one on its own at that
 * size).
 */

interface Batch {
  readonly full: boolean;
  /** A JSON array. */
  readonly events: string;
}

export interface Segment {
  /** A batch from the page; `full` when it starts with a full snapshot. */
  readonly push: (full: boolean, events: string) => void;
  /** What a new viewer replays: from the last full snapshot on, or null before there is one. */
  readonly catchUp: () => string | null;
  /**
   * Ends the step: its recording, or null without a full snapshot. Starts
   * empty when the page sends a fresh snapshot next (`fresh`), else from the
   * last full snapshot, so the next step still replays.
   */
  readonly cut: (fresh: boolean) => string | null;
}

const LIMIT_WITHOUT_SNAPSHOT = 2 * RECORDING_CHECKOUT_CHARS;

const join = (batches: ReadonlyArray<Batch>) =>
  batches.length === 0
    ? null
    : `[${batches
        .map((batch) => batch.events.slice(1, -1))
        .filter((inner) => inner !== "")
        .join(",")}]`;

const fromLastFull = (batches: ReadonlyArray<Batch>) => {
  const last = batches.findLastIndex((batch) => batch.full);
  return last === -1 ? [] : batches.slice(last);
};

export const makeSegment = (): Segment => {
  let batches: Array<Batch> = [];
  let chars = 0;

  const reset = (next: Array<Batch>) => {
    batches = next;
    chars = next.reduce((sum, batch) => sum + batch.events.length, 0);
  };

  return {
    push: (full, events) => {
      if (chars > (full ? RECORDING_CHECKOUT_CHARS : LIMIT_WITHOUT_SNAPSHOT)) reset([]);
      if (!full && batches.length === 0) return;
      batches.push({ full, events });
      chars += events.length;
    },
    catchUp: () => join(fromLastFull(batches)),
    cut: (fresh) => {
      const recording = join(batches);
      reset(fresh ? [] : fromLastFull(batches));
      return recording;
    },
  };
};
