import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// The caller chooses a frozen host tree so concurrent runtime edits cannot
// change what this artifact regression proves.
const [artifactPath, sourceRoot, mode = "candidate"] = process.argv.slice(2);
NodeAssert.ok(
  artifactPath && sourceRoot,
  "Usage: node --experimental-wasm-jspi verify-sort.mjs ARTIFACT SOURCE_ROOT [baseline|candidate]",
);
NodeAssert.ok(["baseline", "candidate"].includes(mode));
NodeAssert.equal(
  typeof WebAssembly.Suspending,
  "function",
  "Run Node with --experimental-wasm-jspi",
);
const load = (path) =>
  import(NodeURL.pathToFileURL(NodePath.resolve(sourceRoot, "apps/cloud/src", path)));
const { KernelFileSystem, KernelOpenFlags } = await load("kernel/KernelFileSystem.ts");
const { KernelProgramRegistry } = await load("kernel/KernelAbi.ts");
const { KernelProgramHost } = await load("kernel/KernelProgramHost.ts");
const { KernelWakeRegistry } = await load("kernel/KernelWakeRegistry.ts");
const { createKernelRipgrepProgram, KERNEL_RIPGREP_PROGRAM_MANIFEST } = await load(
  "kernel/KernelRipgrepProgram.ts",
);
const { createFacetSqliteStorage } = await load("kernel/FacetSqliteStorage.ts");
const { sqliteFixture } = await load("kernel/tests/sqliteFixture.ts");
const { createNodeChildProcess } = await load("isolate/NodeChildProcess.ts");
const artifact = NodeFS.readFileSync(artifactPath);
const sha256 = NodeCrypto.createHash("sha256").update(artifact).digest("hex");
const module = new WebAssembly.Module(artifact);
console.log(
  JSON.stringify({
    artifactPath,
    sourceRoot,
    mode,
    sha256,
    bytes: artifact.length,
    node: process.version,
  }),
);
const sql = sqliteFixture();
const storage = createFacetSqliteStorage(sql.storage, () => 1800000000000000001n);
storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
const filesystem = new KernelFileSystem({
  mounts: [{ path: "/", storage }],
  posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
});
filesystem.mkdir("/work");
filesystem.mkdir("/outside");
filesystem.chdir("/work");
const entries = [
  ["z-old.txt", 1700000000000000000n],
  ["a-mid.txt", 1700000100000000000n],
  ["m-new.txt", 1700000200000000000n],
];
for (const [name, mtimeNs] of [entries[1], entries[2], entries[0]]) {
  const path = `/work/${name}`;
  const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY, 0o644);
  filesystem.write(fd, new TextEncoder().encode(`needle-after ${name}\n`), 0n);
  filesystem.close(fd);
  filesystem.setTimes(path, { atimeNs: mtimeNs, mtimeNs });
}
const directory = filesystem.open("/work", 0x800);
const cwds = ["/work", `/proc/self/fd/${directory}`];
const registry = new KernelProgramRegistry();
registry.register(KERNEL_RIPGREP_PROGRAM_MANIFEST);
const wakes = new KernelWakeRegistry();
const host = new KernelProgramHost({
  registry,
  wakes,
  programs: new Map([
    [
      "/bin/rg",
      {
        manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST,
        implementation: createKernelRipgrepProgram({ module }),
      },
    ],
  ]),
});
const cp = createNodeChildProcess(host, {
  filesystem,
  env: { PATH: "/bin", HOME: "/home/claude", TMPDIR: "/tmp" },
});
const grep = [
  "--hidden",
  "--glob",
  "!.git",
  "--glob",
  "!.svn",
  "--glob",
  "!.hg",
  "--glob",
  "!.bzr",
  "--glob",
  "!.jj",
  "--glob",
  "!.sl",
  "--max-columns",
  "500",
  "--json",
  "-n",
  "needle-after",
  ".",
];
const glob = [
  "--files",
  "--null",
  "--glob",
  "*.txt",
  "--sort=modified",
  "--no-ignore",
  "--hidden",
  ".",
];
const sorted = entries.map(([name]) => `./${name}`);
let checks = 0;
const list = (output) => output.split("\0").filter(Boolean);
function run(name, args, cwd) {
  return new Promise((resolveResult) => {
    cp.execFile("/bin/rg", args, { cwd }, (error, stdout, stderr) => {
      const result = {
        name,
        cwd,
        args,
        code: error?.code ?? 0,
        stdout: String(stdout),
        stderr: String(stderr),
      };
      console.log(JSON.stringify(result));
      resolveResult(result);
    });
  });
}
function success(result) {
  NodeAssert.equal(result.code, 0, JSON.stringify(result));
  NodeAssert.equal(result.stderr, "");
  checks++;
}
async function stdin(name, args, cwd) {
  const child = cp.spawn("/bin/rg", args, { cwd });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ name, cwd, args, code, stdout, stderr }));
    child.stdin.end("needle-stdin\n");
  });
  console.log(JSON.stringify(result));
  return result;
}
try {
  for (const cwd of cwds) {
    const grepResult = await run("exact-grep", grep, cwd);
    success(grepResult);
    const matches = grepResult.stdout
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((record) => record.type === "match");
    NodeAssert.equal(matches.length, entries.length);
    const result = await run("exact-glob", glob, cwd);
    if (mode === "baseline") {
      NodeAssert.equal(result.code, 2);
      NodeAssert.match(
        result.stderr,
        /sorting by last modified isn't supported: operation not supported/,
      );
      NodeAssert.equal(result.stdout, "");
      checks++;
      continue;
    }
    success(result);
    NodeAssert.deepEqual(list(result.stdout), sorted);
    const reversed = await run(
      "reverse-mtime",
      glob.map((arg) => (arg === "--sort=modified" ? "--sortr=modified" : arg)),
      cwd,
    );
    success(reversed);
    NodeAssert.deepEqual(list(reversed.stdout), sorted.toReversed());
    const implicit = await run("implicit-cwd", glob.slice(0, -1), cwd);
    success(implicit);
    NodeAssert.deepEqual(
      list(implicit.stdout),
      entries.map(([name]) => name),
    );
    const absolute = await run("absolute-root", [...glob.slice(0, -1), "/work"], cwd);
    success(absolute);
    NodeAssert.deepEqual(
      list(absolute.stdout),
      entries.map(([name]) => `/work/${name}`),
    );
    const multiple = await run(
      "multiple-file-roots",
      ["--files", "--null", "--sort=modified", "/work/m-new.txt", "z-old.txt", "/work/a-mid.txt"],
      cwd,
    );
    success(multiple);
    NodeAssert.deepEqual(list(multiple.stdout), [
      "z-old.txt",
      "/work/a-mid.txt",
      "/work/m-new.txt",
    ]);
    const missing = await run(
      "missing-second-root",
      ["--files", "--sort=modified", "/work", "/missing-root"],
      cwd,
    );
    NodeAssert.equal(missing.code, 2);
    NodeAssert.match(
      missing.stderr,
      /sorting by last modified isn't supported for \/missing-root:.*No such file/,
    );
    NodeAssert.equal(missing.stdout, "");
    checks++;
    const fromStdin = await stdin("stdin-only", ["--sort=modified", "needle-stdin", "-"], cwd);
    success(fromStdin);
    NodeAssert.equal(fromStdin.stdout, "needle-stdin\n");
    const mixed = await stdin(
      "stdin-and-file",
      ["--sort=modified", "--no-heading", "--with-filename", "needle", "-", "/work/z-old.txt"],
      cwd,
    );
    success(mixed);
    NodeAssert.match(mixed.stdout, /needle-stdin/);
    NodeAssert.match(mixed.stdout, /\/work\/z-old.txt:(?:\d+:)?needle-after z-old.txt/);
  }
  if (mode === "candidate") {
    const pathFilestatGet = 1n << 18n;
    const reduced = [];
    for (const [fd, descriptor] of filesystem.descriptors.entries()) {
      if (descriptor.kind !== "directory") continue;
      const before = descriptor.rightsBase;
      descriptor.rightsBase &= ~pathFilestatGet;
      NodeAssert.equal(descriptor.rightsBase & pathFilestatGet, 0n);
      reduced.push({ fd, before: before.toString(), after: descriptor.rightsBase.toString() });
    }
    NodeAssert.ok(reduced.length > 0);
    console.log(
      JSON.stringify({
        name: "remove-PATH_FILESTAT_GET",
        right: pathFilestatGet.toString(),
        descriptors: reduced,
      }),
    );
    for (const cwd of cwds) {
      const denied = await run("denied-root-metadata", glob, cwd);
      NodeAssert.equal(denied.code, 2);
      NodeAssert.match(denied.stderr, /sorting by last modified isn't supported for \.:/);
      NodeAssert.match(denied.stderr, /Capabilities insufficient \(os error 76\)/);
      NodeAssert.equal(denied.stdout, "");
      checks++;
      const fromStdin = await stdin(
        "stdin-without-path-metadata-right",
        ["--sort=modified", "needle-stdin", "-"],
        cwd,
      );
      success(fromStdin);
      NodeAssert.equal(fromStdin.stdout, "needle-stdin\n");
    }
  }
  console.log(JSON.stringify({ pass: true, mode, checks }));
} finally {
  await host.processes.dispose();
  wakes.dispose();
  filesystem.dispose();
  sql.close();
}
