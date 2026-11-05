import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

// The profiler preload disables general synchronous child APIs after importing this guard.
const ancestryExecFileSync = NodeChildProcess.execFileSync;
const probeOptions = { encoding: "utf8", timeout: 1_000, maxBuffer: 1_024 } as const;

function refuse(reason: string, cause?: unknown): never {
  throw new Error(`WORKERD_LAUNCH_REFUSED: ${reason}`, { cause });
}

function launchPaths() {
  if (NodeProcess.env.HEAVY_SLOT_ACTIVE !== "1") refuse("HEAVY_SLOT_ACTIVE must be 1");
  // homedir uses the OS account when strict launch environments omit HOME.
  const home = NodeOS.homedir();
  if (!home || !NodePath.isAbsolute(home)) refuse("Cannot establish the user home directory");
  return {
    pool: NodePath.join(home, ".t3", "heavy-slots-native"),
    pause: NodePath.join(home, ".t3", "heavy-slots-paused"),
  };
}

function missingFile(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

async function requireUnpaused(path: string) {
  try {
    await NodeFSP.lstat(path);
  } catch (cause) {
    if (missingFile(cause)) return;
    throw cause;
  }
  refuse("Heavy slots are paused");
}

function requireUnpausedSync(path: string) {
  try {
    NodeFS.lstatSync(path);
  } catch (cause) {
    if (missingFile(cause)) return;
    throw cause;
  }
  refuse("Heavy slots are paused");
}

function slotPaths(pool: string, entries: NodeFS.Dirent[]) {
  return entries
    .filter(
      (entry) => entry.isDirectory() && /^slot-[1-9]\d*$/.exec(entry.name)?.[0] === entry.name,
    )
    .map((entry) => NodePath.join(pool, entry.name, "pid"));
}

function slotOwners(contents: string[]) {
  return new Set(
    contents.map((content) => {
      const pid = Number(content);
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        (content !== String(pid) && content !== `${pid}\n`)
      ) {
        refuse("Malformed native slot pidfile");
      }
      return pid;
    }),
  );
}

// heavy-slot writes its wrapper's $$, then waits for `nice <command>` as a child.
// Probe each live ancestor, excluding the caller itself; env flags never prove ownership.
function* ancestorProbes(owners: Set<number>): Generator<number, number, string> {
  const seen = new Set<number>();
  let pid = NodeProcess.pid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const output = (yield pid).trim();
    if (!/^\d+$/.test(output)) refuse("Invalid process ancestry probe");
    const parent = Number(output);
    if (!Number.isSafeInteger(parent) || seen.has(parent)) refuse("Invalid parent PID");
    if (pid !== NodeProcess.pid && owners.has(pid)) return pid;
    pid = parent;
  }
  refuse("No live ancestor owns a native heavy slot");
}

export async function requireWorkerdLaunchAdmission() {
  try {
    const { pool, pause } = launchPaths();
    await requireUnpaused(pause);
    const paths = slotPaths(pool, await NodeFSP.readdir(pool, { withFileTypes: true }));
    const owners = slotOwners(
      await Promise.all(paths.map((path) => NodeFSP.readFile(path, "utf8"))),
    );
    const probes = ancestorProbes(owners);
    let probe = probes.next();
    while (!probe.done) {
      const stdout = await new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          "/bin/ps",
          ["-o", "ppid=", "-p", String(probe.value)],
          probeOptions,
          (error, output) => {
            if (error) reject(error);
            else resolve(output);
          },
        );
      });
      probe = probes.next(stdout);
    }
    const currentOwners = slotOwners(
      await Promise.all(paths.map((path) => NodeFSP.readFile(path, "utf8"))),
    );
    if (!currentOwners.has(probe.value)) refuse("Native slot was released during admission");
    await requireUnpaused(pause);
  } catch (cause) {
    refuse("Native heavy-slot admission failed", cause);
  }
}

/** ChildProcess.spawn is synchronous; its guard must finish before creating the native process. */
export function requireWorkerdLaunchAdmissionSync() {
  try {
    const { pool, pause } = launchPaths();
    requireUnpausedSync(pause);
    const paths = slotPaths(pool, NodeFS.readdirSync(pool, { withFileTypes: true }));
    const owners = slotOwners(paths.map((path) => NodeFS.readFileSync(path, "utf8")));
    const probes = ancestorProbes(owners);
    let probe = probes.next();
    while (!probe.done) {
      probe = probes.next(
        ancestryExecFileSync("/bin/ps", ["-o", "ppid=", "-p", String(probe.value)], probeOptions),
      );
    }
    const currentOwners = slotOwners(paths.map((path) => NodeFS.readFileSync(path, "utf8")));
    if (!currentOwners.has(probe.value)) refuse("Native slot was released during admission");
    requireUnpausedSync(pause);
  } catch (cause) {
    refuse("Native heavy-slot admission failed", cause);
  }
}
