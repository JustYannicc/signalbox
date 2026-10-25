import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const IMAGE_REF = /^(.+)@(sha256:[a-f0-9]{64})$/;
const PLATFORM = /^linux\/(amd64|arm64)$/;
const ENTRY_TYPES = new Set([
  "file",
  "directory",
  "symlink",
  "fifo",
  "socket",
  "character",
  "block",
  "unknown",
]);
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;

function isCanonicalPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\0") &&
    (path === "/" ||
      path
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

function parentPath(path) {
  const slash = path.lastIndexOf("/");
  return slash === 0 ? "/" : path.slice(0, slash);
}

function isUnder(path, root) {
  return path === root || (root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`));
}

function validateCapture(snapshot, captureSha256) {
  if (snapshot?.complete !== true || snapshot.entryCount !== snapshot.entries?.length)
    throw new TypeError("Capture is incomplete");
  if (!HEX_SHA256.test(snapshot.captureSha256 ?? "") || snapshot.captureSha256 !== captureSha256)
    throw new TypeError("Capture script hash does not match the source file");
  if (
    !Array.isArray(snapshot.path) ||
    snapshot.path.length === 0 ||
    !Array.isArray(snapshot.excludedRoots) ||
    !Array.isArray(snapshot.entries)
  )
    throw new TypeError("Capture paths and entries are required");
  for (const directory of snapshot.path)
    if (!isCanonicalPath(directory))
      throw new TypeError("Capture PATH must contain canonical absolute directories");

  const excluded = new Set();
  let previousRoot = "";
  for (const root of snapshot.excludedRoots) {
    if (!isCanonicalPath(root) || root === "/" || root <= previousRoot || excluded.has(root))
      throw new TypeError("Capture excluded roots must be sorted, unique absolute paths");
    if ([...excluded].some((other) => isUnder(root, other) || isUnder(other, root)))
      throw new TypeError("Capture excluded roots must not overlap");
    excluded.add(root);
    previousRoot = root;
  }

  const byPath = new Map();
  let previousPath = "";
  for (const entry of snapshot.entries) {
    if (!entry || !isCanonicalPath(entry.path) || entry.path <= previousPath)
      throw new TypeError("Captured entries must be unique, canonical, and sorted by path");
    if ([...excluded].some((root) => isUnder(entry.path, root)))
      throw new TypeError(`Capture includes a live-only path: ${entry.path}`);
    if (!ENTRY_TYPES.has(entry.type))
      throw new TypeError(`Invalid captured entry type: ${entry.path}`);
    for (const value of [entry.size, entry.nlink])
      if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value))
        throw new TypeError(`Invalid captured stat integer: ${entry.path}`);
    for (const value of [entry.atimeNs, entry.mtimeNs, entry.ctimeNs])
      if (typeof value !== "string" || !SIGNED_DECIMAL.test(value))
        throw new TypeError(`Invalid captured stat time: ${entry.path}`);
    if (
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o7777 ||
      !Number.isInteger(entry.uid) ||
      entry.uid < 0 ||
      entry.uid >= 0xffff_ffff ||
      !Number.isInteger(entry.gid) ||
      entry.gid < 0 ||
      entry.gid >= 0xffff_ffff
    )
      throw new TypeError(`Invalid captured POSIX metadata: ${entry.path}`);
    if (entry.type === "symlink") {
      if (
        typeof entry.target !== "string" ||
        entry.target.length === 0 ||
        entry.target.includes("\0")
      )
        throw new TypeError(`Captured symlink target is missing: ${entry.path}`);
    } else if (entry.target !== undefined) {
      throw new TypeError(`Non-symlink capture has a target: ${entry.path}`);
    }
    for (const identity of [entry.ino, entry.dev])
      if (
        identity !== undefined &&
        (typeof identity !== "string" || !UNSIGNED_DECIMAL.test(identity))
      )
        throw new TypeError(`Invalid captured inode identity: ${entry.path}`);
    byPath.set(entry.path, entry);
    previousPath = entry.path;
  }
  if (byPath.get("/")?.type !== "directory")
    throw new TypeError("Capture must include the image root directory");
  for (const entry of snapshot.entries) {
    if (entry.path === "/") continue;
    const parent = byPath.get(parentPath(entry.path));
    if (parent?.type !== "directory")
      throw new TypeError(`Capture parent directory is missing: ${parentPath(entry.path)}`);
  }
}

export function finalizeMachineProgramInventory(snapshot, input) {
  if (snapshot?.format !== "signalbox-machine-files-capture-v1")
    throw new TypeError("Unsupported machine file capture");
  if (!IMAGE_ID.test(input.sourceImageId ?? "") || snapshot.sourceImageId !== input.sourceImageId)
    throw new TypeError("Capture does not belong to the selected build image");
  if (
    !REVISION.test(input.sourceRevision ?? "") ||
    snapshot.sourceRevision !== input.sourceRevision
  )
    throw new TypeError("Capture does not belong to the selected source revision");
  if (!PLATFORM.test(input.platform ?? "") || snapshot.platform !== input.platform)
    throw new TypeError("Capture platform does not match the selected image platform");
  if (!input.dockerfile || typeof input.dockerfile !== "string")
    throw new TypeError("Runner Dockerfile provenance is required");
  validateCapture(snapshot, input.captureSha256);

  const ref = IMAGE_REF.exec(input.imageRef ?? "");
  if (ref === null || !input.imageRepository || ref[1] !== input.imageRepository)
    throw new TypeError("Published image reference must be pinned to the expected repository");

  return {
    format: "signalbox-machine-files-v1",
    imageRef: input.imageRef,
    imageDigest: ref[2],
    platform: input.platform,
    provenance: {
      sourceRevision: input.sourceRevision,
      sourceImageId: input.sourceImageId,
      dockerfile: input.dockerfile,
      captureSha256: snapshot.captureSha256,
    },
    path: snapshot.path,
    excludedRoots: snapshot.excludedRoots,
    entries: snapshot.entries,
  };
}

function argumentsOf(values) {
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || args.has(name))
      throw new Error("Expected unique --name value arguments");
    args.set(name, value);
  }
  return args;
}

async function prepare() {
  const args = argumentsOf(process.argv.slice(2));
  const required = (name) => {
    const value = args.get(`--${name}`);
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };
  const snapshot = JSON.parse(NodeFS.readFileSync(required("snapshot"), "utf8"));
  const captureSha256 = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(new URL("./capture.mjs", import.meta.url)))
    .digest("hex");
  const inventory = finalizeMachineProgramInventory(snapshot, {
    imageRepository: required("image-repository"),
    imageRef: required("image-ref"),
    sourceImageId: required("source-image-id"),
    sourceRevision: required("source-revision"),
    platform: required("platform"),
    dockerfile: required("dockerfile"),
    captureSha256,
  });
  const output = NodePath.resolve(required("output"));
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
  NodeFS.renameSync(temporary, output);
  process.stdout.write(`${output}\n`);
}

if (
  process.argv[1] &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  await prepare();
}
