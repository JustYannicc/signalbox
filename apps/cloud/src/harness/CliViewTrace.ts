/**
 * What held the CLI's filesystem view or Computer's machine layer, for diagnosing stalls. Counts,
 * sizes and durations only, never paths or bytes.
 */
export type CliViewTrace =
  | {
      readonly kind: "round";
      readonly phase: "start" | "end";
      readonly mode: "incremental" | "index";
      readonly entries: number;
      readonly reread?: number;
      readonly durationMs?: number;
      readonly failed?: true;
    }
  | {
      readonly kind: "digest";
      readonly phase: "start" | "end";
      readonly files: number;
      readonly bytes: number;
      readonly unchanged?: number;
      readonly durationMs?: number;
    }
  | {
      readonly kind: "machine-command";
      readonly phase: "start" | "exit";
      readonly running: number;
      readonly changes: number;
      readonly durationMs?: number;
    }
  | { readonly kind: "loop-lag"; readonly lagMs: number; readonly activity: string }
  /** A synchronous call the view could not answer from what it holds; the CLI got EIO or EMFILE. */
  | {
      readonly kind: "sync-miss";
      readonly operation: string;
      readonly reason: "content" | "unindexed" | "descriptors";
      readonly root: "home" | "workspace" | "other";
      /** Misses of this path so far; traced at 1, 2, 4… so a poller's are counted, not lost. */
      readonly count: number;
    }
  /** A sync-read file over a pinning limit: its own size, or the pinned total it would make. */
  | { readonly kind: "too-large"; readonly bytes: number; readonly limit: number }
  /** A round failed; the view waits this long before the next one. */
  | { readonly kind: "backoff"; readonly failures: number; readonly retryMs: number }
  /**
   * One page of the CLI's index as Computer reads it, at its first entry. Durations are wall time
   * as the runtime reports it, which in a Worker moves only across I/O.
   */
  | {
      readonly kind: "index-page";
      readonly phase: "start" | "end";
      readonly cursor: number;
      readonly entries: number;
      readonly durationMs?: number;
      readonly failed?: true;
    }
  /** Traces a bounded buffer could not keep, so a gap is visible as a gap. */
  | { readonly kind: "dropped"; readonly count: number };
