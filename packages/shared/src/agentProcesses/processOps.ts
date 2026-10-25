// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native process checks run in Node before application Effect setup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import type { ProcessIdentity, ProcessInspection, ProcessMetrics, ProcessOps } from "./types.ts";

const COMMAND_TIMEOUT_MS = 1_500;
// oxlint-disable-next-line t3code/no-global-process-runtime -- This dependency-free adapter needs the OS before application setup.
const nativePlatform = process.platform;

// ps start times have only second precision; libproc returns the PID's exact start time.
// This ctypes layout follows Apple's proc_bsdinfo and PROC_PIDTBSDINFO headers:
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
const MAC_PROCESS_START_TIME_SCRIPT = String.raw`
import ctypes
import sys

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]

pid = int(sys.argv[1])
if pid <= 1:
    raise SystemExit(2)

info = ProcBsdInfo()
if ctypes.sizeof(info) != 136:
    raise SystemExit(3)
libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
proc_pidinfo = libproc.proc_pidinfo
proc_pidinfo.argtypes = [
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_uint64,
    ctypes.POINTER(ProcBsdInfo),
    ctypes.c_int,
]
proc_pidinfo.restype = ctypes.c_int
size = proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
if size != ctypes.sizeof(info) or info.pbi_pid != pid or info.pbi_start_tvsec == 0 or info.pbi_start_tvusec > 999999:
    raise SystemExit(1)
print("{}:{:06d}".format(info.pbi_start_tvsec, info.pbi_start_tvusec))
`;

const runFile = (file: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 256 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const linuxIdentity = async (pid: number): Promise<ProcessIdentity | undefined> => {
  const bootId = await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8");
  const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  // Field 22 follows state (field 3), the first token after comm.
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  const currentBoot = bootId.trim();
  if (currentBoot.length === 0 || startTime === undefined || !/^\d+$/.test(startTime)) {
    return undefined;
  }
  return { platform: "linux", bootId: currentBoot, startTime };
};

const macIdentity = async (pid: number): Promise<ProcessIdentity | undefined> => {
  const [bootTime, startedAt] = await Promise.all([
    runFile("sysctl", ["-n", "kern.boottime"]),
    runFile("/usr/bin/python3", ["-c", MAC_PROCESS_START_TIME_SCRIPT, String(pid)]),
  ]);
  const bootId = bootTime.trim();
  const startTime = startedAt.trim();
  const match = /^(\d+):(\d{6})$/.exec(startTime);
  if (bootId.length === 0 || match === null || Number(match[2]) > 999_999) return undefined;
  return { platform: "darwin", bootId, startTime };
};

const identityFor = async (pid: number): Promise<ProcessIdentity | undefined> => {
  if (nativePlatform === "linux") return linuxIdentity(pid);
  if (nativePlatform === "darwin") return macIdentity(pid);
  return undefined;
};

const processExists = (pid: number): "yes" | "no" | "unknown" => {
  try {
    process.kill(pid, 0);
    return "yes";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "no";
    if (code === "EPERM") return "yes";
    return "unknown";
  }
};

const inspectMac = async (pid: number): Promise<ProcessInspection> => {
  let identity: ProcessIdentity | undefined;
  try {
    identity = await macIdentity(pid);
  } catch {
    const existence = processExists(pid);
    return existence === "no"
      ? { state: "missing" }
      : { state: "unknown", reason: existence === "yes" ? "inaccessible" : "invalid-identity" };
  }
  if (identity === undefined) {
    const existence = processExists(pid);
    return existence === "no"
      ? { state: "missing" }
      : { state: "unknown", reason: "invalid-identity" };
  }

  let cwd: string;
  try {
    const output = await runFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const path = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1))
      .find((line) => line.length > 0);
    if (path === undefined) return { state: "unknown", reason: "inaccessible" };
    cwd = await NodeFSP.realpath(path);
  } catch {
    const existence = processExists(pid);
    return existence === "no"
      ? { state: "missing" }
      : { state: "unknown", reason: existence === "yes" ? "inaccessible" : "invalid-identity" };
  }

  const currentIdentity = await macIdentity(pid).catch(() => undefined);
  if (currentIdentity === undefined) {
    return processExists(pid) === "no"
      ? { state: "missing" }
      : { state: "unknown", reason: "invalid-identity" };
  }
  if (!sameIdentity(identity, currentIdentity))
    return { state: "unknown", reason: "invalid-identity" };
  return { state: "running", identity: currentIdentity, cwd };
};

const inspectLinux = async (pid: number): Promise<ProcessInspection> => {
  let identity: ProcessIdentity | undefined;
  try {
    identity = await linuxIdentity(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && (error as NodeJS.ErrnoException).path === `/proc/${pid}/stat`) {
      return { state: "missing" };
    }
    if (code === "EACCES" || code === "EPERM") return { state: "unknown", reason: "inaccessible" };
    return { state: "unknown", reason: "invalid-identity" };
  }
  if (identity === undefined) return { state: "unknown", reason: "invalid-identity" };

  let cwd: string;
  try {
    cwd = await NodeFSP.realpath(`/proc/${pid}/cwd`);
  } catch {
    return processExists(pid) === "no"
      ? { state: "missing" }
      : { state: "unknown", reason: "inaccessible" };
  }

  const currentIdentity = await linuxIdentity(pid).catch(() => undefined);
  if (currentIdentity === undefined) {
    return processExists(pid) === "no"
      ? { state: "missing" }
      : { state: "unknown", reason: "invalid-identity" };
  }
  if (!sameIdentity(identity, currentIdentity))
    return { state: "unknown", reason: "invalid-identity" };
  return { state: "running", identity: currentIdentity, cwd };
};

const inspect = async (pid: number): Promise<ProcessInspection> => {
  if (nativePlatform === "linux") return inspectLinux(pid);
  if (nativePlatform === "darwin") return inspectMac(pid);
  return { state: "unknown", reason: "unsupported-platform" };
};

const identify = async (pid: number): Promise<ProcessIdentity | undefined> => {
  if (nativePlatform !== "linux" && nativePlatform !== "darwin") return undefined;
  try {
    return await identityFor(pid);
  } catch {
    return undefined;
  }
};

const processMetrics = async (
  pids: ReadonlyArray<number>,
): Promise<ReadonlyMap<number, ProcessMetrics>> => {
  const result = new Map<number, ProcessMetrics>();
  for (let offset = 0; offset < pids.length; offset += 128) {
    const batch = pids.slice(offset, offset + 128);
    try {
      const output = await runFile("ps", ["-o", "pid=,%cpu=,rss=", "-p", batch.join(",")]);
      for (const line of output.split(/\r?\n/)) {
        const [pidText, cpuText, rssText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const cpuPercent = Number(cpuText);
        const rssKiB = Number(rssText);
        if (!batch.includes(pid)) continue;
        result.set(pid, {
          ...(Number.isFinite(cpuPercent) ? { cpuPercent } : {}),
          ...(Number.isFinite(rssKiB) && rssKiB >= 0
            ? { rssBytes: Math.trunc(rssKiB * 1024) }
            : {}),
        });
      }
    } catch {
      // Status remains useful when this best-effort resource lookup is unavailable.
    }

    try {
      const output = await runFile("lsof", [
        "-a",
        "-p",
        batch.join(","),
        "-iTCP",
        "-sTCP:LISTEN",
        "-Fpn",
      ]);
      let currentPid: number | undefined;
      for (const line of output.split(/\r?\n/)) {
        if (line.startsWith("p")) {
          const parsedPid = Number(line.slice(1));
          currentPid = batch.includes(parsedPid) ? parsedPid : undefined;
        } else if (line.startsWith("n") && currentPid !== undefined) {
          const port = Number(/:(\d+)$/.exec(line.slice(1))?.[1]);
          if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
            const previous = result.get(currentPid) ?? {};
            result.set(currentPid, {
              ...previous,
              listeningPorts: [...new Set([...(previous.listeningPorts ?? []), port])].sort(
                (a, b) => a - b,
              ),
            });
          }
        }
      }
    } catch {
      // lsof is optional; declared ports and process metrics remain available.
    }
  }
  return result;
};

export const createNodeProcessOps = (): ProcessOps => ({
  identify,
  inspect,
  metrics: processMetrics,
  sendSignal: (pid, signal) => {
    if (nativePlatform !== "linux" && nativePlatform !== "darwin") {
      throw new Error(`Process signaling is unsupported on ${nativePlatform}`);
    }
    process.kill(pid, signal);
  },
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});

export const sameIdentity = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
  left.platform === right.platform &&
  left.bootId === right.bootId &&
  left.startTime === right.startTime;
