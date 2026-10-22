import {
  markNodeBuiltinCapability,
  type NodeBuiltinCapabilityDeclaration,
} from "../../NodeBuiltinCapabilities.ts";

type CapabilityEntry = readonly [name: string, evidence: string];

const supportedFs: readonly CapabilityEntry[] = [
  [
    "openSync",
    "createSyncApi parses Node flags and opens a descriptor on the supplied KernelFileSystem.",
  ],
  ["closeSync", "createSyncApi closes the descriptor owned by the supplied KernelFileSystem."],
  [
    "readSync",
    "createSyncApi maps Node buffer offsets and positions to KernelFileSystem descriptor reads.",
  ],
  ["writeSync", "createSyncApi maps strings and byte views to KernelFileSystem descriptor writes."],
  ["readFileSync", "The file adapter reads guest paths or descriptors through KernelFileSystem."],
  ["writeFileSync", "The file adapter writes guest paths or descriptors through KernelFileSystem."],
  [
    "appendFileSync",
    "The file adapter appends through KernelFileSystem path or descriptor operations.",
  ],
  ["fstatSync", "The stat adapter reads descriptor metadata through KernelFileSystem.fstat."],
  ["statSync", "The stat adapter reads guest path metadata through KernelFileSystem.stat."],
  ["lstatSync", "The stat adapter reads guest path metadata without following the final symlink."],
  ["readdirSync", "The directory adapter enumerates entries through KernelFileSystem.readdir."],
  ["readlinkSync", "The metadata adapter reads symlink targets through KernelFileSystem.readlink."],
  [
    "realpathSync",
    "The canonical resolver uses KernelFileSystem.realpath; native is the same guest resolver.",
  ],
  ["renameSync", "The directory adapter renames entries through KernelFileSystem.rename."],
  ["mkdirSync", "The directory adapter creates guest directories through KernelFileSystem.mkdir."],
  [
    "mkdtempSync",
    "The directory adapter creates a unique guest directory through KernelFileSystem.mkdtemp.",
  ],
  ["rmSync", "The directory adapter removes guest files or trees through KernelFileSystem.rm."],
  ["rmdirSync", "The directory adapter removes guest directories through KernelFileSystem.rmdir."],
  ["unlinkSync", "The directory adapter removes guest entries through KernelFileSystem.unlink."],
  ["linkSync", "The directory adapter creates guest hard links through KernelFileSystem.link."],
  ["symlinkSync", "The directory adapter creates guest symlinks through KernelFileSystem.symlink."],
  ["copyFileSync", "The file adapter copies bytes between guest paths through KernelFileSystem."],
  [
    "truncateSync",
    "The metadata adapter truncates a guest path or descriptor through KernelFileSystem.",
  ],
  ["ftruncateSync", "The metadata adapter truncates a guest descriptor through KernelFileSystem."],
  ["fsyncSync", "The metadata adapter synchronizes a guest descriptor through KernelFileSystem."],
  ["utimesSync", "The metadata adapter sets guest path times through KernelFileSystem.setTimes."],
  [
    "existsSync",
    "The adapter checks guest path presence with KernelFileSystem.stat and returns false on errors.",
  ],
  ["open", "The callback adapter opens a descriptor through the supplied KernelFileSystem."],
  ["close", "The callback adapter closes a descriptor through the supplied KernelFileSystem."],
  ["read", "The callback adapter maps buffer ranges to KernelFileSystem descriptor reads."],
  [
    "write",
    "The callback adapter maps strings and byte views to KernelFileSystem descriptor writes.",
  ],
  ["readFile", "The callback adapter reads guest paths or descriptors through KernelFileSystem."],
  ["writeFile", "The callback adapter writes guest paths or descriptors through KernelFileSystem."],
  [
    "appendFile",
    "The callback adapter appends through KernelFileSystem path or descriptor operations.",
  ],
  ["fstat", "The callback stat adapter reads descriptor metadata through KernelFileSystem.fstat."],
  ["fsync", "The callback adapter synchronizes a guest descriptor through KernelFileSystem."],
  ["stat", "The callback stat adapter reads guest path metadata through KernelFileSystem.stat."],
  [
    "lstat",
    "The callback stat adapter reads guest path metadata without following the final symlink.",
  ],
  [
    "readdir",
    "The callback directory adapter enumerates entries through KernelFileSystem.readdir.",
  ],
  [
    "readlink",
    "The callback metadata adapter reads symlink targets through KernelFileSystem.readlink.",
  ],
  [
    "realpath",
    "The callback adapter uses KernelFileSystem.realpath; native is the same guest resolver.",
  ],
  ["rename", "The callback directory adapter renames entries through KernelFileSystem.rename."],
  [
    "mkdir",
    "The callback directory adapter creates guest directories through KernelFileSystem.mkdir.",
  ],
  [
    "mkdtemp",
    "The callback directory adapter creates unique guest directories through KernelFileSystem.mkdtemp.",
  ],
  [
    "unlink",
    "The callback directory adapter removes guest entries through KernelFileSystem.unlink.",
  ],
  [
    "rmdir",
    "The callback directory adapter removes guest directories through KernelFileSystem.rmdir.",
  ],
  [
    "rm",
    "The callback directory adapter removes guest files or trees through KernelFileSystem.rm.",
  ],
  [
    "link",
    "The callback directory adapter creates guest hard links through KernelFileSystem.link.",
  ],
  [
    "symlink",
    "The callback directory adapter creates guest symlinks through KernelFileSystem.symlink.",
  ],
  [
    "utimes",
    "The callback metadata adapter sets guest path times through KernelFileSystem.setTimes.",
  ],
];

const supportedPromises: readonly CapabilityEntry[] = [
  [
    "appendFile",
    "The promise adapter appends through KernelFileSystem path, descriptor, or FileHandle operations.",
  ],
  ["copyFile", "The promise adapter copies bytes between guest paths through KernelFileSystem."],
  ["link", "The promise adapter creates guest hard links through KernelFileSystem.link."],
  [
    "lstat",
    "The promise stat adapter reads guest path metadata without following the final symlink.",
  ],
  ["lutimes", "The promise adapter sets guest path times without following the final symlink."],
  [
    "mkdir",
    "The promise directory adapter creates guest directories through KernelFileSystem.mkdir.",
  ],
  [
    "mkdtemp",
    "The promise directory adapter creates a unique guest directory through KernelFileSystem.mkdtemp.",
  ],
  [
    "open",
    "The promise adapter opens a KernelFileSystem descriptor and returns its FileHandle wrapper.",
  ],
  [
    "readFile",
    "The promise adapter reads guest paths, descriptors, or FileHandles through KernelFileSystem.",
  ],
  ["readdir", "The promise directory adapter enumerates entries through KernelFileSystem.readdir."],
  [
    "readlink",
    "The promise metadata adapter reads symlink targets through KernelFileSystem.readlink.",
  ],
  [
    "realpath",
    "The promise adapter uses KernelFileSystem.realpath with no host filesystem fallback.",
  ],
  ["rename", "The promise directory adapter renames entries through KernelFileSystem.rename."],
  ["rm", "The promise directory adapter removes guest files or trees through KernelFileSystem.rm."],
  [
    "rmdir",
    "The promise directory adapter removes guest directories through KernelFileSystem.rmdir.",
  ],
  ["stat", "The promise stat adapter reads guest path metadata through KernelFileSystem.stat."],
  [
    "symlink",
    "The promise directory adapter creates guest symlinks through KernelFileSystem.symlink.",
  ],
  [
    "unlink",
    "The promise directory adapter removes guest entries through KernelFileSystem.unlink.",
  ],
  [
    "utimes",
    "The promise metadata adapter sets guest path times through KernelFileSystem.setTimes.",
  ],
  [
    "writeFile",
    "The promise adapter writes guest paths, descriptors, or FileHandles through KernelFileSystem.",
  ],
];

const conditionalFs: readonly CapabilityEntry[] = [
  [
    "createReadStream",
    "NodeFsReadStream reads guest descriptors with Node backpressure; paths must belong to the supplied KernelFileSystem.",
  ],
  [
    "createWriteStream",
    "NodeFsWriteStream writes guest descriptors; start with append flags is rejected and paths stay in KernelFileSystem.",
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
    "The vendored Node glob core runs against KernelFileSystem adapters and a bounded set of internal module shims.",
  ],
  [
    "opendir",
    "The adapter returns a guest-backed directory handle; recursive opendir is explicitly unsupported.",
  ],
];

const permissionFs: readonly CapabilityEntry[] = [
  [
    "accessSync",
    "KernelFileSystem access checks require a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chmodSync",
    "KernelFileSystem chmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchmodSync",
    "KernelFileSystem fchmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chownSync",
    "KernelFileSystem chown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchownSync",
    "KernelFileSystem fchown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "access",
    "KernelFileSystem access checks require a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chmod",
    "KernelFileSystem chmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chown",
    "KernelFileSystem chown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchmod",
    "KernelFileSystem fchmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "fchown",
    "KernelFileSystem fchown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
];

const permissionPromises: readonly CapabilityEntry[] = [
  [
    "access",
    "KernelFileSystem access checks require a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chmod",
    "KernelFileSystem chmod requires a configured POSIX policy and POSIX metadata on the mounted storage.",
  ],
  [
    "chown",
    "KernelFileSystem chown requires a configured POSIX policy and POSIX metadata on the mounted storage.",
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
    markNodeBuiltinCapability(descriptor.value, { status, evidence });
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
