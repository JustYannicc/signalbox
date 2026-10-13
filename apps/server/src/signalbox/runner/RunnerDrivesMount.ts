// @effect-diagnostics nodeBuiltinImport:off - rclone is a long-lived child whose PID we signal.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

/**
 * Mounts `/drives` on the machine (#141): `rclone mount` of the context
 * server's read-only WebDAV share (`RunnerDrivesDav.ts`), so the harness's
 * own tools (`ls`, `cat`, `rg`, its Read tool) read every drive the user can
 * read, lazily: nothing is fetched until it is opened. The mount is
 * read-only, and a write fails with EROFS.
 *
 * It needs FUSE: the Runner image ships `rclone` and `fuse3`, and the machine
 * runs its container with `/dev/fuse` (`BoatMachineBackend.ts`). Anywhere
 * else, such as a development host, nothing is mounted and the context
 * tool's `list_drives` and `read_drive_file` read the same paths.
 *
 * A new turn pins a new view; `refresh` sends rclone SIGHUP, which drops its
 * cached listings so the mount shows that view.
 */

/** How long rclone gets to mount, checked every 100 ms. */
const MOUNT_CHECKS = 50;

const isMounted = (mountPoint: string) =>
  Effect.sync(() => {
    try {
      return NodeFS.readFileSync("/proc/mounts", "utf8")
        .split("\n")
        .some((line) => line.split(" ")[1] === mountPoint);
    } catch {
      return false;
    }
  });

const commandWorks = (command: string, args: ReadonlyArray<string>) =>
  Effect.sync(() => NodeChildProcess.spawnSync(command, args, { stdio: "ignore" }).status === 0);

/** Lazily unmounts what an earlier Runner may have left at `mountPoint`; errors ignored. */
const unmount = (mountPoint: string) =>
  Effect.sync(() => {
    NodeChildProcess.spawnSync("fusermount3", ["-uz", mountPoint], { stdio: "ignore" });
  });

export interface DrivesMount {
  readonly mountPoint: string;
  /** Makes the mount show the latest pinned view. */
  readonly refresh: Effect.Effect<void>;
}

/**
 * Mounts `davUrl` at `mountPoint` for as long as the scope lives, or answers
 * null when this machine can't (no FUSE, no rclone, no mount point).
 */
export const mountDrives = Effect.fn("mountDrives")(function* (input: {
  readonly davUrl: string;
  readonly mountPoint: string;
}) {
  const { mountPoint } = input;
  const ready =
    NodeFS.existsSync("/dev/fuse") &&
    NodeFS.existsSync(mountPoint) &&
    (yield* commandWorks("rclone", ["version"]));
  if (!ready) {
    yield* Effect.logInfo("not mounting /drives: this machine has no FUSE or rclone", {
      mountPoint,
    });
    return null;
  }
  yield* unmount(mountPoint);
  const child = NodeChildProcess.spawn(
    "rclone",
    [
      "mount",
      ":webdav:",
      mountPoint,
      "--webdav-url",
      input.davUrl,
      "--read-only",
      "--vfs-cache-mode",
      "off",
      // Listings are dropped on every new view (`refresh`), not on a timer.
      "--dir-cache-time",
      "1000h",
      "--log-level",
      "ERROR",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
  });
  // rclone unmounts on SIGTERM. Unmounting here could take down a newer Runner's mount.
  yield* Effect.addFinalizer(() => Effect.sync(() => child.kill("SIGTERM")));
  let mounted = false;
  for (let check = 0; check < MOUNT_CHECKS && !mounted && child.exitCode === null; check++) {
    yield* Effect.sleep("100 millis");
    mounted = yield* isMounted(mountPoint);
  }
  if (!mounted) {
    yield* Effect.logWarning("mounting /drives failed", { mountPoint, stderr });
    return null;
  }
  yield* Effect.logInfo("mounted /drives", { mountPoint });
  return {
    mountPoint,
    refresh: Effect.sync(() => {
      if (child.exitCode === null) child.kill("SIGHUP");
    }),
  } satisfies DrivesMount;
});
