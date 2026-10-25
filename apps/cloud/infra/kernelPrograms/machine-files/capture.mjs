import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const imageId = NodeProcess.env.SIGNALBOX_RUNNER_IMAGE_ID;
const platform = NodeProcess.env.SIGNALBOX_RUNNER_PLATFORM;
const sourceRevision = NodeProcess.env.SIGNALBOX_RUNNER_REVISION;
if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? ""))
  throw new Error("SIGNALBOX_RUNNER_IMAGE_ID must identify the built image");
if (!/^linux\/(amd64|arm64)$/.test(platform ?? ""))
  throw new Error("SIGNALBOX_RUNNER_PLATFORM must be linux/amd64 or linux/arm64");
if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? ""))
  throw new Error("SIGNALBOX_RUNNER_REVISION must be the 40-character source revision");
if (NodeProcess.platform !== "linux") throw new Error("Machine inventory capture needs Linux");
const architecture = NodeProcess.arch === "x64" ? "amd64" : NodeProcess.arch;
if (platform !== `linux/${architecture}`)
  throw new Error(`Capture runtime does not match requested platform: ${platform}`);

const captureSha256 = NodeCrypto.createHash("sha256")
  .update(NodeFS.readFileSync(new URL(import.meta.url)))
  .digest("hex");
const excludedCandidates = ["/dev", "/proc", "/run", "/sys", "/tmp", "/var/tmp", "/.dockerenv"];
const path = (NodeProcess.env.PATH ?? "").split(":");
if (path.length === 0 || path.some((entry) => !canonicalPath(entry)))
  throw new Error("The image PATH must contain absolute canonical directories");

function canonicalPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\0") &&
    (value === "/" ||
      value
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

function utf8(buffer, description) {
  const value = buffer.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(buffer))
    throw new Error(`Image path is not valid UTF-8: ${description}`);
  return value;
}

function typeOf(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice()) return "character";
  if (stat.isBlockDevice()) return "block";
  return "unknown";
}

function entryAt(file, path) {
  const stat = NodeFS.lstatSync(file, { bigint: true });
  const type = typeOf(stat);
  const target =
    type === "symlink" ? utf8(NodeFS.readlinkSync(file, { encoding: "buffer" }), path) : undefined;
  return {
    path,
    type,
    size: String(stat.size),
    nlink: String(stat.nlink),
    atimeNs: String(stat.atimeNs),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    mode: Number(stat.mode & 0o7777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    ...(target === undefined ? {} : { target }),
  };
}

function unescapeMountPath(path) {
  return path.replace(/\\([0-7]{3})/g, (_match, value) =>
    String.fromCharCode(Number.parseInt(value, 8)),
  );
}

const mountInfo = new TextDecoder("utf-8", { fatal: true }).decode(
  NodeFS.readFileSync("/proc/self/mountinfo"),
);
const mountPoints = mountInfo.split("\n").flatMap((line) => {
  if (line.length === 0) return [];
  const mount = line.split(" - ", 1)[0]?.split(" ")[4];
  const path = mount === undefined ? undefined : unescapeMountPath(mount);
  if (path === undefined || path === "/" || !canonicalPath(path)) return [];
  return [path];
});
const excludedRoots = [...new Set([...excludedCandidates, ...mountPoints])]
  .filter(canonicalPath)
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  .reduce((roots, path) => {
    if (!roots.some((root) => path === root || path.startsWith(`${root === "/" ? "" : root}/`)))
      roots.push(path);
    return roots;
  }, []);
const excluded = new Set(excludedRoots);
const entries = [];
const pending = ["/"];
while (pending.length > 0) {
  const file = pending.pop();
  if (file === undefined) break;
  if (excluded.has(file)) continue;
  const current = entryAt(file, file);
  entries.push(current);
  if (current.type !== "directory") continue;

  const names = NodeFS.readdirSync(file, { encoding: "buffer" });
  for (const name of names) {
    const segment = utf8(name, NodePath.posix.join(file, name.toString("hex")));
    const child = NodePath.posix.join(file, segment);
    if (!canonicalPath(child)) throw new Error(`Image contains an invalid path: ${child}`);
    pending.push(child);
  }
}

entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
const snapshot = {
  format: "signalbox-machine-files-capture-v1",
  complete: true,
  entryCount: entries.length,
  sourceImageId: imageId,
  sourceRevision,
  captureSha256,
  platform,
  path,
  excludedRoots,
  entries,
};
NodeProcess.stdout.write(`${JSON.stringify(snapshot)}\n`);
