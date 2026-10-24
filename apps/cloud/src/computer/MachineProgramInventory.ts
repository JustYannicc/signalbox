import { resolveInventoryPath } from "./machineFiles/InventoryPath.ts";

export type MachineProgramEntryType =
  | "file"
  | "directory"
  | "symlink"
  | "fifo"
  | "socket"
  | "character"
  | "block"
  | "unknown";

/** Node-shaped metadata encoded without JSON's loss of nanosecond integers. */
export interface MachineProgramEntry {
  readonly path: string;
  readonly type: MachineProgramEntryType;
  readonly size: string;
  readonly nlink: string;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  /** The original readlink result. Relative targets remain relative. */
  readonly target?: string;
  /** Image capture omits inode identities that may vary between machine instances. */
  readonly ino?: string;
  /** Image capture omits device identities that may vary between machine instances. */
  readonly dev?: string;
}

export interface MachineProgramInventoryProvenance {
  readonly sourceRevision: string;
  /** Local image ID checked against the published digest before preparation. */
  readonly sourceImageId: MachineImageDigest;
  readonly dockerfile: string;
  readonly captureSha256: string;
}

export type MachineImageDigest = `sha256:${string}`;

/** Complete metadata for the immutable image's read-only root, except live roots. */
export interface MachineProgramInventory {
  readonly format: "signalbox-machine-files-v1";
  /** Full OCI reference, pinned with `@sha256`, never a mutable tag. */
  readonly imageRef: string;
  readonly imageDigest: MachineImageDigest;
  readonly platform: string;
  readonly provenance: MachineProgramInventoryProvenance;
  /** Image PATH, kept in its original order. */
  readonly path: readonly string[];
  /** Contents under these roots come from the live machine, not the image. */
  readonly excludedRoots: readonly string[];
  /** Sorted by path and complete outside `excludedRoots`. */
  readonly entries: readonly MachineProgramEntry[];
}

/** Wire entry consumed by the lower filesystem adapter. It contains no file bytes. */
export type MachineLowerFileSystemEntry = MachineProgramEntry & {
  readonly symlinkParent?: string;
};

export interface MachineProgramInventoryIndex {
  readonly path: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly lookup: (
    paths: readonly string[],
  ) => readonly (MachineLowerFileSystemEntry | undefined)[];
  /** `undefined` means the directory is outside the immutable image inventory. */
  readonly readdir: (path: string) => readonly MachineLowerFileSystemEntry[] | undefined;
  /** True when a live-only child makes the image directory listing incomplete. */
  readonly needsLiveDirectory: (path: string) => boolean;
  readonly readlink: (path: string) => string;
  readonly isExcluded: (path: string) => boolean;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;
const IMAGE_REF = /^.+@sha256:([a-f0-9]{64})$/;

/** Linux paths may contain backslashes; only POSIX separators are structural here. */
export function isCanonicalMachinePath(path: string): boolean {
  if (path === "/") return true;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\0")) return false;
  return path
    .slice(1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

export function assertCanonicalMachinePath(path: string): void {
  if (!isCanonicalMachinePath(path)) throw new TypeError(`Invalid machine path: ${path}`);
}

/** Validate the prepared artifact before it is allowed into a Worker bundle. */
export function validateMachineProgramInventory(
  inventory: MachineProgramInventory,
): MachineProgramInventory {
  validateEnvelope(inventory);
  buildIndex(inventory);
  return inventory;
}

/**
 * Creates an O(1)-lookup view without scanning the inventory at host open.
 * The O(n) validation/index pass happens on the first filesystem query.
 */
export function indexMachinePrograms(
  inventory: MachineProgramInventory,
): MachineProgramInventoryIndex {
  validateEnvelope(inventory);
  let indexed:
    | {
        readonly byPath: ReadonlyMap<string, MachineProgramEntry>;
        readonly children: ReadonlyMap<string, readonly MachineProgramEntry[]>;
      }
    | undefined;

  const index = () => {
    if (indexed !== undefined) return indexed;
    indexed = buildIndex(inventory);
    return indexed;
  };

  const resolve = (path: string, followFinal: boolean) => {
    assertCanonicalMachinePath(path);
    return resolveInventoryPath(path, index().byPath, inventory.excludedRoots, followFinal);
  };
  const isExcluded = (path: string) => {
    assertCanonicalMachinePath(path);
    return (
      inventory.excludedRoots.some((root) => underRoot(path, root)) ||
      resolve(path, false).kind === "excluded"
    );
  };
  const needsLiveDirectory = (path: string) => {
    assertCanonicalMachinePath(path);
    if (inventory.excludedRoots.some((root) => parentPath(root) === path)) return true;
    const resolved = resolve(path, true);
    return (
      resolved.kind === "excluded" ||
      (resolved.kind === "entry" &&
        inventory.excludedRoots.some((root) => parentPath(root) === resolved.path))
    );
  };

  return {
    path: inventory.path,
    excludedRoots: inventory.excludedRoots,
    lookup(paths) {
      return paths.map((path) => {
        const resolved = resolve(path, false);
        return resolved.kind === "entry" ? atPath(resolved.entry, path) : undefined;
      });
    },
    readdir(path) {
      if (needsLiveDirectory(path)) return undefined;
      const resolved = resolve(path, true);
      if (resolved.kind !== "entry" || resolved.entry.type !== "directory") return undefined;
      return (index().children.get(resolved.path) ?? []).map((entry) =>
        atPath(
          entry,
          `${path === "/" ? "" : path}/${entry.path.slice(entry.path.lastIndexOf("/") + 1)}`,
        ),
      );
    },
    needsLiveDirectory,
    readlink(path) {
      const resolved = resolve(path, false);
      if (resolved.kind === "excluded") throw new TypeError(`Machine path is excluded: ${path}`);
      if (
        resolved.kind !== "entry" ||
        resolved.entry.type !== "symlink" ||
        resolved.entry.target === undefined
      )
        throw new TypeError(`Machine path is not a symlink: ${path}`);
      return resolved.entry.target;
    },
    isExcluded,
  };
}

function atPath(entry: MachineProgramEntry, path: string): MachineLowerFileSystemEntry {
  return entry.path === path
    ? entry
    : {
        ...entry,
        path,
        ...(entry.type === "symlink" ? { symlinkParent: parentPath(entry.path) } : {}),
      };
}

function validateEnvelope(inventory: MachineProgramInventory): void {
  if (!inventory || inventory.format !== "signalbox-machine-files-v1")
    throw new TypeError("Unsupported machine inventory format");
  if (typeof inventory.imageRef !== "string" || typeof inventory.imageDigest !== "string")
    throw new TypeError("Machine inventory image identity is required");
  const ref = IMAGE_REF.exec(inventory.imageRef);
  if (
    ref === null ||
    !DIGEST.test(inventory.imageDigest) ||
    `sha256:${ref[1]}` !== inventory.imageDigest
  )
    throw new TypeError("Machine inventory image reference and digest do not match");
  if (typeof inventory.platform !== "string" || inventory.platform.length === 0)
    throw new TypeError("Machine inventory platform is required");
  const provenance = inventory.provenance;
  if (
    !provenance ||
    !REVISION.test(provenance.sourceRevision) ||
    !DIGEST.test(provenance.sourceImageId) ||
    !HEX_SHA256.test(provenance.captureSha256) ||
    typeof provenance.dockerfile !== "string" ||
    provenance.dockerfile.length === 0
  )
    throw new TypeError("Machine inventory provenance is invalid");
  if (
    !Array.isArray(inventory.path) ||
    !Array.isArray(inventory.excludedRoots) ||
    !Array.isArray(inventory.entries)
  )
    throw new TypeError("Machine inventory paths and entries are required");
  for (const directory of inventory.path) assertCanonicalMachinePath(directory);
  const exclusions = new Set<string>();
  let previousRoot = "";
  for (const root of inventory.excludedRoots) {
    assertCanonicalMachinePath(root);
    if (root === "/" || root < previousRoot || exclusions.has(root))
      throw new TypeError("Invalid excluded machine roots");
    if (
      inventory.excludedRoots.some(
        (other) => other !== root && (underRoot(root, other) || underRoot(other, root)),
      )
    )
      throw new TypeError("Overlapping excluded machine roots");
    exclusions.add(root);
    previousRoot = root;
  }
}

function buildIndex(inventory: MachineProgramInventory) {
  const byPath = new Map<string, MachineProgramEntry>();
  const mutableChildren = new Map<string, MachineProgramEntry[]>();
  let previous = "";
  for (const entry of inventory.entries) {
    validateEntry(entry);
    if (entry.path < previous) throw new TypeError("Machine inventory entries are not sorted");
    if (byPath.has(entry.path)) throw new TypeError("Duplicate machine inventory path");
    if (inventory.excludedRoots.some((root) => underRoot(entry.path, root)))
      throw new TypeError("Machine inventory includes an excluded mount path");
    byPath.set(entry.path, entry);
    if (entry.path !== "/") {
      const parent = parentPath(entry.path);
      const children = mutableChildren.get(parent);
      if (children === undefined) mutableChildren.set(parent, [entry]);
      else children.push(entry);
    }
    previous = entry.path;
  }
  if (byPath.get("/")?.type !== "directory")
    throw new TypeError("Machine root directory is missing");
  for (const entry of inventory.entries) {
    if (entry.path === "/") continue;
    const parent = parentPath(entry.path);
    if (inventory.excludedRoots.some((root) => underRoot(parent, root))) continue;
    if (byPath.get(parent)?.type !== "directory")
      throw new TypeError(`Machine inventory parent is missing: ${parent}`);
  }
  return { byPath, children: mutableChildren };
}

function validateEntry(entry: MachineProgramEntry): void {
  if (!entry || !isCanonicalMachinePath(entry.path))
    throw new TypeError("Invalid machine entry path");
  if (
    entry.type !== "file" &&
    entry.type !== "directory" &&
    entry.type !== "symlink" &&
    entry.type !== "fifo" &&
    entry.type !== "socket" &&
    entry.type !== "character" &&
    entry.type !== "block" &&
    entry.type !== "unknown"
  )
    throw new TypeError(`Invalid machine entry type: ${entry.path}`);
  for (const value of [entry.size, entry.nlink])
    if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value))
      throw new TypeError(`Invalid machine stat integer: ${entry.path}`);
  for (const value of [entry.atimeNs, entry.mtimeNs, entry.ctimeNs])
    if (typeof value !== "string" || !SIGNED_DECIMAL.test(value))
      throw new TypeError(`Invalid machine stat time: ${entry.path}`);
  if (
    !Number.isInteger(entry.mode) ||
    entry.mode < 0 ||
    entry.mode > 0o7777 ||
    !validId(entry.uid) ||
    !validId(entry.gid)
  )
    throw new TypeError(`Invalid machine POSIX metadata: ${entry.path}`);
  if (entry.type === "symlink") {
    if (
      typeof entry.target !== "string" ||
      entry.target.length === 0 ||
      entry.target.includes("\0")
    )
      throw new TypeError(`Machine symlink target is missing: ${entry.path}`);
  } else if (entry.target !== undefined) {
    throw new TypeError(`Non-symlink machine entry has a target: ${entry.path}`);
  }
  for (const identity of [entry.ino, entry.dev]) {
    if (
      identity !== undefined &&
      (typeof identity !== "string" || !UNSIGNED_DECIMAL.test(identity))
    )
      throw new TypeError(`Invalid machine inode identity: ${entry.path}`);
  }
}

function validId(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < 0xffff_ffff;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === 0 ? "/" : path.slice(0, slash);
}

function underRoot(path: string, root: string): boolean {
  return path === root || (root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`));
}
