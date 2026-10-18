import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "packages/worker/wasm/bash/coreutils/busybox.wasm",
  sha256: "7d1b34a31d74473be1fdb50706ed75e8ec765b68878b4fb2cf6ab486cbcb2631",
  bytes: 241_159,
  program: "BusyBox 1.37.0",
  license: "GPL-2.0-only",
});
const IMPORTS = Object.freeze([
  "nimbus_proc.account:function",
  "nimbus_proc.chmod:function",
  "nimbus_proc.chown:function",
  "nimbus_proc.fchmod:function",
  "nimbus_proc.identity:function",
  "nimbus_proc.startup_cwd:function",
  "nimbus_proc.stat_metadata:function",
  "wasi_snapshot_preview1.args_get:function",
  "wasi_snapshot_preview1.args_sizes_get:function",
  "wasi_snapshot_preview1.clock_time_get:function",
  "wasi_snapshot_preview1.environ_get:function",
  "wasi_snapshot_preview1.environ_sizes_get:function",
  "wasi_snapshot_preview1.fd_close:function",
  "wasi_snapshot_preview1.fd_datasync:function",
  "wasi_snapshot_preview1.fd_fdstat_get:function",
  "wasi_snapshot_preview1.fd_fdstat_set_flags:function",
  "wasi_snapshot_preview1.fd_filestat_get:function",
  "wasi_snapshot_preview1.fd_prestat_dir_name:function",
  "wasi_snapshot_preview1.fd_prestat_get:function",
  "wasi_snapshot_preview1.fd_read:function",
  "wasi_snapshot_preview1.fd_readdir:function",
  "wasi_snapshot_preview1.fd_renumber:function",
  "wasi_snapshot_preview1.fd_seek:function",
  "wasi_snapshot_preview1.fd_sync:function",
  "wasi_snapshot_preview1.fd_tell:function",
  "wasi_snapshot_preview1.fd_write:function",
  "wasi_snapshot_preview1.path_create_directory:function",
  "wasi_snapshot_preview1.path_filestat_get:function",
  "wasi_snapshot_preview1.path_filestat_set_times:function",
  "wasi_snapshot_preview1.path_link:function",
  "wasi_snapshot_preview1.path_open:function",
  "wasi_snapshot_preview1.path_readlink:function",
  "wasi_snapshot_preview1.path_remove_directory:function",
  "wasi_snapshot_preview1.path_rename:function",
  "wasi_snapshot_preview1.path_symlink:function",
  "wasi_snapshot_preview1.path_unlink_file:function",
  "wasi_snapshot_preview1.poll_oneoff:function",
  "wasi_snapshot_preview1.proc_exit:function",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(process.argv[2] ?? scriptDir);
const url = `https://raw.githubusercontent.com/AshishKumar4/Nimbus/${ARTIFACT.revision}/${ARTIFACT.path}`;
const response = await fetch(url);
if (!response.ok) throw new Error(`Could not fetch pinned BusyBox: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (bytes.byteLength !== ARTIFACT.bytes || sha256 !== ARTIFACT.sha256) {
  throw new Error(`Nimbus BusyBox pin mismatch: ${bytes.byteLength} bytes ${sha256}`);
}

const module = await WebAssembly.compile(bytes);
const imports = WebAssembly.Module.imports(module)
  .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
  .sort();
if (JSON.stringify(imports) !== JSON.stringify([...IMPORTS].sort())) {
  throw new Error("Pinned BusyBox import inventory changed");
}
const exports = WebAssembly.Module.exports(module)
  .map(({ name, kind }) => `${name}:${kind}`)
  .sort();
if (JSON.stringify(exports) !== JSON.stringify(["_start:function", "memory:memory"])) {
  throw new Error("Pinned BusyBox exports changed");
}

await mkdir(join(outputDir, "bin"), { recursive: true });
await writeFile(join(outputDir, "bin/busybox.wasm"), bytes);
await writeFile(
  join(outputDir, "busybox.provenance.json"),
  `${JSON.stringify({ ...ARTIFACT, imports, exports }, null, 2)}\n`,
);
console.log(JSON.stringify({ outputDir, ...ARTIFACT, imports: imports.length }));
