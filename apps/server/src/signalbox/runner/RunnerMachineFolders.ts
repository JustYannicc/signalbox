import type { OutsideFolder } from "./RunnerMachineState.ts";
import type { MachineLayout } from "./RunnerModelAccess.ts";

/**
 * Codex's indexes of its rollouts, which it rebuilds from `sessions` when they
 * are missing. They name each rollout by its absolute path on the machine that
 * wrote it, so carried to a machine where that path isn't, `thread/resume`
 * finds no rollout and the thread starts over (#644). The `_5` and `_1` are
 * the pinned Codex's schema versions; update them when the image updates Codex.
 */
export const CODEX_ROLLOUT_INDEXES = [
  "state_5.sqlite",
  "state_5.sqlite-wal",
  "state_5.sqlite-shm",
  "thread_history_1.sqlite",
  "thread_history_1.sqlite-wal",
  "thread_history_1.sqlite-shm",
];

/**
 * A thread's folders outside its checkout that its machine state keeps
 * (#490): its home, and its harnesses' config, without what the Runner
 * writes there at every start (the harness settings pointing at this
 * machine's gateway) or saves another way (session transcripts, #132).
 * Nor the shell snapshots each harness session writes again, which export
 * its whole environment and so the folder's secrets, or Codex's logs.
 */
export const outsideFolders = (layout: MachineLayout): ReadonlyArray<OutsideFolder> => [
  { name: "home", label: "~", dir: layout.home, exclude: [], caches: [".cache"] },
  {
    name: "claude",
    label: "~/.claude",
    dir: layout.claudeHome,
    // Its own settings, transcripts saved on their own, and logs it rewrites all through a turn.
    exclude: ["settings.json", "projects", "debug", "statsig", "shell-snapshots"],
    caches: [],
  },
  {
    name: "codex",
    label: "~/.codex",
    dir: layout.codexHome,
    exclude: ["config.toml", "sessions", "shell_snapshots", "log", ...CODEX_ROLLOUT_INDEXES],
    caches: [],
  },
];
