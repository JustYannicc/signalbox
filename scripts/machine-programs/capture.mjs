import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

// Run inside the immutable image, as its normal command user, after all installs.
const image = NodeProcess.argv[2];
if (!/^.+@sha256:[a-f0-9]{64}$/.test(image ?? "")) {
  throw new Error("Usage: capture.mjs IMAGE@sha256:DIGEST");
}
const directories = [...new Set(NodeProcess.env.PATH.split(":"))];
const entries = new Map();
function capture(file) {
  if (entries.has(file)) return;
  const metadata = NodeFS.lstatSync(file);
  const entry = {
    path: file,
    mode: metadata.mode & 0o7777,
    uid: metadata.uid,
    gid: metadata.gid,
  };
  const resolved = NodeFS.realpathSync(file);
  if (metadata.isSymbolicLink() || resolved !== file) {
    // /bin may be an existing catalog directory rather than the image's /usr/bin alias.
    // Absolute targets preserve lookup when the two directory layouts are combined.
    entry.target = resolved;
    if (metadata.isSymbolicLink()) entry.link = NodeFS.readlinkSync(file);
    entries.set(file, entry);
    capture(NodePath.resolve(NodePath.dirname(file), entry.target));
  } else {
    if (!metadata.isFile()) throw new Error(`Not a program file: ${file}`);
    entries.set(file, entry);
  }
}
for (const directory of directories) {
  if (!NodePath.isAbsolute(directory)) throw new Error(`Nonabsolute image PATH: ${directory}`);
  if (!NodeFS.existsSync(directory)) continue;
  for (const name of NodeFS.readdirSync(directory).sort()) {
    const file = NodePath.join(directory, name);
    if (!NodeFS.statSync(file).isFile()) continue;
    try {
      NodeFS.accessSync(file, NodeFS.constants.X_OK);
    } catch {
      continue;
    }
    capture(file);
  }
}
const host = { platform: NodeProcess.platform, architecture: NodeProcess.arch };
console.log(
  JSON.stringify(
    {
      image,
      platform: `${host.platform}/${host.architecture}`,
      uid: NodeProcess.getuid(),
      gid: NodeProcess.getgid(),
      path: directories,
      entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
    },
    null,
    2,
  ),
);
