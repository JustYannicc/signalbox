/**
 * Reads the working directories of running processes: `/proc` on Linux, one
 * `lsof` call on macOS. Other platforms, and processes that exited or belong
 * to another user, are left out.
 *
 * @module processCwd
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../../../processRunner.ts";

/** `lsof -Fn` output: a `p<pid>` line, then the fd's `n<path>`. */
function parseLsofCwds(stdout: string): ReadonlyMap<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined && Number.isInteger(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

export const lookupCwds = Effect.fn("processCwd.lookupCwds")(function* (
  pids: ReadonlyArray<number>,
) {
  if (pids.length === 0) return new Map<number, string>();
  const platform = yield* HostProcessPlatform;
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* Effect.forEach(
      pids,
      (pid) =>
        fs.readLink(`/proc/${pid}/cwd`).pipe(
          Effect.map((cwd) => [[pid, cwd] as const]),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: 16 },
    );
    return new Map(entries.flat());
  }
  if (platform === "darwin") {
    const runner = yield* ProcessRunner.ProcessRunner;
    const output = yield* runner
      .run({
        command: "/usr/sbin/lsof",
        args: ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"],
        timeout: "10 seconds",
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    return new Map(output === undefined ? [] : parseLsofCwds(output.stdout));
  }
  return new Map<number, string>();
});
