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
  /** Traces a bounded buffer could not keep, so a gap is visible as a gap. */
  | { readonly kind: "dropped"; readonly count: number };
