import {
  markNodeBuiltinCapability,
  type NodeBuiltinCapabilityDeclaration,
} from "../../NodeBuiltinCapabilities.ts";

type CapabilityEntry = readonly [name: string, evidence: string];

const supportedFs: readonly CapabilityEntry[] = [
  [
    "openSync",
    "createSyncApi parses Node flags and opens a descriptor on the supplied NodeFsBackend.",
  ],
  ["closeSync", "createSyncApi closes the descriptor owned by the supplied NodeFsBackend."],
  [
    "readSync",
    "createSyncApi maps Node buffer offsets and positions to NodeFsBackend descriptor reads.",
  ],
  ["writeSync", "createSyncApi maps strings and byte views to NodeFsBackend descriptor writes."],
  ["readFileSync", "The file adapter reads guest paths or descriptors through NodeFsBackend."],
  ["writeFileSync", "The file adapter writes guest paths or descriptors through NodeFsBackend."],
  [
    "appendFileSync",
    "The file adapter appends through NodeFsBackend path or descriptor operations.",
  ],
  ["fstatSync", "The stat adapter reads descriptor metadata through NodeFsBackend.fstat."],
  ["statSync", "The stat adapter reads guest path metadata through NodeFsBackend.stat."],
  ["lstatSync", "The stat adapter reads guest path metadata without following the final symlink."],
  ["readdirSync", "The directory adapter enumerates entries through NodeFsBackend.readdir."],
  ["readlinkSync", "The metadata adapter reads symlink targets through NodeFsBackend.readlink."],
  [
    "realpathSync",
    "The canonical resolver uses NodeFsBackend.realpath; native is the same guest resolver.",
  ],
  ["renameSync", "The directory adapter renames entries through NodeFsBackend.rename."],
  ["mkdirSync", "The directory adapter creates guest directories through NodeFsBackend.mkdir."],
  [
    "mkdtempSync",
    "The directory adapter creates a unique guest directory through NodeFsBackend.mkdtemp.",
  ],
  ["rmSync", "The directory adapter removes guest files or trees through NodeFsBackend.rm."],
  ["rmdirSync", "The directory adapter removes guest directories through NodeFsBackend.rmdir."],
  ["unlinkSync", "The directory adapter removes guest entries through NodeFsBackend.unlink."],
  ["linkSync", "The directory adapter creates guest hard links through NodeFsBackend.link."],
  ["symlinkSync", "The directory adapter creates guest symlinks through NodeFsBackend.symlink."],
  ["copyFileSync", "The file adapter copies bytes between guest paths through NodeFsBackend."],
  [
    "truncateSync",
    "The metadata adapter truncates a guest path or descriptor through NodeFsBackend.",
  ],
  ["ftruncateSync", "The metadata adapter truncates a guest descriptor through NodeFsBackend."],
  ["fsyncSync", "The metadata adapter synchronizes a guest descriptor through NodeFsBackend."],
  ["utimesSync", "The metadata adapter sets guest path times through NodeFsBackend.setTimes."],
  [
    "existsSync",
    "The adapter checks guest path presence with NodeFsBackend.stat and returns false on errors.",
  ],
  ["open", "The callback adapter opens a descriptor through the supplied NodeFsBackend."],
  ["close", "The callback adapter closes a descriptor through the supplied NodeFsBackend."],
  ["read", "The callback adapter maps buffer ranges to NodeFsBackend descriptor reads."],
  ["write", "The callback adapter maps strings and byte views to NodeFsBackend descriptor writes."],
  ["readFile", "The callback adapter reads guest paths or descriptors through NodeFsBackend."],
  ["writeFile", "The callback adapter writes guest paths or descriptors through NodeFsBackend."],
  [
    "appendFile",
    "The callback adapter appends through NodeFsBackend path or descriptor operations.",
  ],
  ["fstat", "The callback stat adapter reads descriptor metadata through NodeFsBackend.fstat."],
  ["fsync", "The callback adapter synchronizes a guest descriptor through NodeFsBackend."],
  ["stat", "The callback stat adapter reads guest path metadata through NodeFsBackend.stat."],
  [
    "lstat",
    "The callback stat adapter reads guest path metadata without following the final symlink.",
  ],
  ["readdir", "The callback directory adapter enumerates entries through NodeFsBackend.readdir."],
  [
    "readlink",
    "The callback metadata adapter reads symlink targets through NodeFsBackend.readlink.",
  ],
  [
    "realpath",
    "The callback adapter uses NodeFsBackend.realpath; native is the same guest resolver.",
  ],
  ["rename", "The callback directory adapter renames entries through NodeFsBackend.rename."],
  [
    "mkdir",
    "The callback directory adapter creates guest directories through NodeFsBackend.mkdir.",
  ],
  [
    "mkdtemp",
    "The callback directory adapter creates unique guest directories through NodeFsBackend.mkdtemp.",
  ],
  ["unlink", "The callback directory adapter removes guest entries through NodeFsBackend.unlink."],
  [
    "rmdir",
    "The callback directory adapter removes guest directories through NodeFsBackend.rmdir.",
  ],
  ["rm", "The callback directory adapter removes guest files or trees through NodeFsBackend.rm."],
  ["link", "The callback directory adapter creates guest hard links through NodeFsBackend.link."],
  [
    "symlink",
    "The callback directory adapter creates guest symlinks through NodeFsBackend.symlink.",
  ],
  ["utimes", "The callback metadata adapter sets guest path times through NodeFsBackend.setTimes."],
];

const supportedPromises: readonly CapabilityEntry[] = [
  [
    "appendFile",
    "The promise adapter appends through NodeFsBackend path, descriptor, or FileHandle operations.",
  ],
  ["copyFile", "The promise adapter copies bytes between guest paths through NodeFsBackend."],
  ["link", "The promise adapter creates guest hard links through NodeFsBackend.link."],
  [
    "lstat",
    "The promise stat adapter reads guest path metadata without following the final symlink.",
  ],
  ["lutimes", "The promise adapter sets guest path times without following the final symlink."],
  ["mkdir", "The promise directory adapter creates guest directories through NodeFsBackend.mkdir."],
  [
    "mkdtemp",
    "The promise directory adapter creates a unique guest directory through NodeFsBackend.mkdtemp.",
  ],
  [
    "open",
    "The promise adapter opens a NodeFsBackend descriptor and returns its FileHandle wrapper.",
  ],
  [
    "readFile",
    "The promise adapter reads guest paths, descriptors, or FileHandles through NodeFsBackend.",
  ],
  ["readdir", "The promise directory adapter enumerates entries through NodeFsBackend.readdir."],
  [
    "readlink",
    "The promise metadata adapter reads symlink targets through NodeFsBackend.readlink.",
  ],
  ["realpath", "The promise adapter uses NodeFsBackend.realpath with no host filesystem fallback."],
  ["rename", "The promise directory adapter renames entries through NodeFsBackend.rename."],
  ["rm", "The promise directory adapter removes guest files or trees through NodeFsBackend.rm."],
  ["rmdir", "The promise directory adapter removes guest directories through NodeFsBackend.rmdir."],
  ["stat", "The promise stat adapter reads guest path metadata through NodeFsBackend.stat."],
  [
    "symlink",
    "The promise directory adapter creates guest symlinks through NodeFsBackend.symlink.",
  ],
  ["unlink", "The promise directory adapter removes guest entries through NodeFsBackend.unlink."],
  ["utimes", "The promise metadata adapter sets guest path times through NodeFsBackend.setTimes."],
  [
    "writeFile",
    "The promise adapter writes guest paths, descriptors, or FileHandles through NodeFsBackend.",
  ],
];

const conditionalFs: readonly CapabilityEntry[] = [
  [
    "createReadStream",
    "NodeFsReadStream reads guest descriptors with Node backpressure; paths must belong to the supplied NodeFsBackend.",
  ],
  [
    "createWriteStream",
    "NodeFsWriteStream writes guest descriptors; start with append flags is rejected and paths stay in NodeFsBackend.",
  ],
  [
    "watch",
    "The guest watcher polls snapshots every 100 ms, so changes between samples can coalesce; it does not watch host paths.",
  ],
  [
    "watchFile",
    "The guest stat watcher polls (5007 ms by default), so notifications are sampled rather than native filesystem events.",
  ],
  ["unwatchFile", "This removes listeners from the guest polling watcher created by watchFile."],
];

const conditionalPromises: readonly CapabilityEntry[] = [
  [
    "glob",
    "The vendored Node glob core runs against NodeFsBackend adapters and a bounded set of internal module shims.",
  ],
  [
    "opendir",
    "The adapter snapshots guest directory names and buffers at most bufferSize Dirents. Recursive opendir is explicitly unsupported; storage does not yet provide paged name enumeration.",
  ],
];

const permissionFs: readonly CapabilityEntry[] = [
  [
    "accessSync",
    "NodeFsBackend access checks require a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chmodSync",
    "NodeFsBackend chmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchmodSync",
    "NodeFsBackend fchmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chownSync",
    "NodeFsBackend chown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchownSync",
    "NodeFsBackend fchown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "access",
    "NodeFsBackend access checks require a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chmod",
    "NodeFsBackend chmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chown",
    "NodeFsBackend chown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchmod",
    "NodeFsBackend fchmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchown",
    "NodeFsBackend fchown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
];

const permissionPromises: readonly CapabilityEntry[] = [
  [
    "access",
    "NodeFsBackend access checks require a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chmod",
    "NodeFsBackend chmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chown",
    "NodeFsBackend chown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
];

const unsupportedFs: readonly CapabilityEntry[] = [
  [
    "statfsSync",
    "The public adapter is an explicit unsupportedFs stub; it does not synthesize filesystem statistics.",
  ],
];

const unsupportedPromises: readonly CapabilityEntry[] = [
  ["statfs", "The promise adapter delegates to the explicit unsupported statfsSync stub."],
];

function markEntries(
  module: object,
  entries: readonly CapabilityEntry[],
  status: NodeBuiltinCapabilityDeclaration["status"],
): void {
  for (const [name, evidence] of entries) {
    const descriptor = Object.getOwnPropertyDescriptor(module, name);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError("Expected fs." + name + " to be an own callable property");
    }
    markNodeBuiltinCapability(descriptor.value, {
      status,
      evidence,
      ...(status === "unsupported"
        ? { failure: { kind: "named-error", code: "ENOTSUP" } as const }
        : {}),
    });
  }
}

export function declareNodeFsCapabilities(
  fs: object,
  promises: object,
  hasPosixPolicy: boolean,
): void {
  markEntries(fs, supportedFs, "supported");
  markEntries(promises, supportedPromises, "supported");
  markEntries(fs, conditionalFs, "conditional");
  markEntries(promises, conditionalPromises, "conditional");
  markEntries(fs, permissionFs, hasPosixPolicy ? "supported" : "conditional");
  markEntries(promises, permissionPromises, hasPosixPolicy ? "supported" : "conditional");
  markEntries(fs, unsupportedFs, "unsupported");
  markEntries(promises, unsupportedPromises, "unsupported");
}
