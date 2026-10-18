import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import {
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
} from "../../../src/kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import { KernelProcessTable } from "../../../src/kernel/KernelProcessTable.ts";
import { createKernelAsyncWasi } from "../../../src/kernel/KernelWasi.ts";
import { createKernelCoreutilsImports } from "../../../src/kernel/KernelCoreutilsImports.ts";
import {
  KERNEL_COREUTILS_COMMANDS,
  registerKernelCoreutilsPrograms,
} from "../../../src/kernel/KernelCoreutilsPrograms.ts";
import { sqliteFixture } from "../../../src/kernel/tests/sqliteFixture.ts";

class RecordingProcessTable extends KernelProcessTable {
  failure;

  spawn(parent, launch, release, options) {
    return super.spawn(
      parent,
      (identity) => {
        const child = launch(identity);
        return {
          ...child,
          completion: child.completion.catch((error) => {
            this.failure = error;
            throw error;
          }),
        };
      },
      release,
      options,
    );
  }
}

const preparedDirectory = NodePath.resolve(
  process.argv[2] ?? NodeURL.fileURLToPath(new URL("./", import.meta.url)),
);
const artifactDirectory = NodePath.join(preparedDirectory, "bin");
const provenance = JSON.parse(
  NodeFS.readFileSync(NodePath.join(preparedDirectory, "provenance.json"), "utf8"),
);
const modules = Object.fromEntries(
  KERNEL_COREUTILS_COMMANDS.map((command) => [command, loadModule(command)]),
);
const database = sqliteFixture();
const storage = createFacetSqliteStorage(database.storage, () => 1_800_000_000_000_000_001n);
storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
const filesystem = new KernelFileSystem({
  mounts: [{ path: "/", storage }],
  posix: {
    credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
    umask: 0o022,
  },
});
const wakes = new KernelWakeRegistry();
const registry = new KernelProgramRegistry();
const programs = registerKernelCoreutilsPrograms(registry, modules);
NodeAssert.equal(programs.size, 13, "all 13 pinned commands must be registered");
const processes = new RecordingProcessTable({ wakes });
const host = new KernelProgramHost({ registry, wakes, processes, programs });
const encoder = new TextEncoder();

try {
  filesystem.mkdir("/work");
  filesystem.chdir("/work");
  writeFile(filesystem, "/work/source.txt", "alpha line\nalpha line\nbeta\n", 0o640);
  writeFile(filesystem, "/source.txt", "wrong root decoy\n", 0o600);
  const mkdirModeProbe = await probeMkdirMode();
  NodeAssert.equal(mkdirModeProbe.exitCode, 0);
  NodeAssert.equal(mkdirModeProbe.mode, 0o700);
  NodeAssert.ok(
    mkdirModeProbe.events.some((event) => event.namespace === "host_fs" && event.name === "chmod"),
    "mkdir -m must reach the supported host_fs.chmod import",
  );
  process.stdout.write(`${JSON.stringify({ mkdirModeProbe })}\n`);

  const results = [];
  results.push(await run("echo", ["coreutils echo"]));
  results.push(await run("printf", ["%s\\n", "coreutils printf"]));
  results.push(await run("pwd", []));
  results.push(await run("mkdir", ["-m", "700", "relative-dir"]));
  results.push(await run("ls", ["-1", "."]));
  results.push(await run("cat", ["source.txt"]));
  results.push(await run("head", ["-n", "1", "source.txt"]));
  results.push(await run("tail", ["-n", "1", "source.txt"]));
  results.push(await run("wc", ["-l", "-w", "-c", "source.txt"]));
  results.push(await run("uniq", ["source.txt"]));
  results.push(await run("cp", ["source.txt", "copied.txt"]));
  NodeAssert.equal(readFile(filesystem, "/work/copied.txt"), "alpha line\nalpha line\nbeta\n");
  results.push(await run("mv", ["copied.txt", "moved.txt"]));
  NodeAssert.equal(readFile(filesystem, "/work/copied.txt"), undefined);
  NodeAssert.equal(readFile(filesystem, "/work/moved.txt"), "alpha line\nalpha line\nbeta\n");
  results.push(await run("rm", ["moved.txt"]));
  NodeAssert.equal(readFile(filesystem, "/work/moved.txt"), undefined);

  const conflictingPwd = await run("pwd", [], { PWD: "/" });
  assertResult(conflictingPwd, "/work\n");
  const relativeReadWithConflictingPwd = await run("cat", ["source.txt"], { PWD: "/" });
  assertResult(relativeReadWithConflictingPwd, "alpha line\nalpha line\nbeta\n");
  NodeAssert.equal(readFile(filesystem, "/source.txt"), "wrong root decoy\n");

  NodeAssert.equal(results.length, KERNEL_COREUTILS_COMMANDS.length);
  assertResult(results[0], "coreutils echo\n");
  assertResult(results[1], "coreutils printf\n");
  assertResult(results[2], "/work\n");
  assertResult(results[3], "");
  NodeAssert.match(results[4].stdout, /(?:^|\n)relative-dir(?:\n|$)/);
  assertResult(results[5], "alpha line\nalpha line\nbeta\n");
  assertResult(results[6], "alpha line\n");
  assertResult(results[7], "beta\n");
  NodeAssert.match(results[8].stdout, /^\s*3\s+5\s+27\s+source\.txt\n$/);
  assertResult(results[9], "alpha line\nbeta\n");
  assertResult(results[10], "");
  assertResult(results[11], "");
  assertResult(results[12], "");

  NodeAssert.equal(filesystem.stat("/work/relative-dir").type, "directory");
  NodeAssert.deepEqual(filesystem.getPosixMetadata("/work/relative-dir"), {
    mode: 0o700,
    uid: 1000,
    gid: 1000,
  });
  NodeAssert.equal(readFile(filesystem, "/work/source.txt"), "alpha line\nalpha line\nbeta\n");
  NodeAssert.equal(filesystem.getPosixMetadata("/work/source.txt").mode, 0o640);

  const mkdirModes = [];
  mkdirModes.push(await run("mkdir", ["-p", "-m", "711", "nested-parent/leaf"]));
  assertResult(mkdirModes[0], "");
  NodeAssert.equal(filesystem.getPosixMetadata("/work/nested-parent").mode, 0o755);
  NodeAssert.equal(filesystem.getPosixMetadata("/work/nested-parent/leaf").mode, 0o711);

  const previousUmask = filesystem.setUmask(0o077);
  NodeAssert.equal(previousUmask, 0o022);
  mkdirModes.push(await run("mkdir", ["-p", "private-parent/leaf"]));
  assertResult(mkdirModes[1], "");
  NodeAssert.equal(filesystem.getPosixMetadata("/work/private-parent").mode, 0o700);
  NodeAssert.equal(filesystem.getPosixMetadata("/work/private-parent/leaf").mode, 0o700);
  NodeAssert.equal(filesystem.posixPolicy?.umask, 0o077);
  NodeAssert.equal(filesystem.setUmask(previousUmask), 0o077);
  NodeAssert.equal(filesystem.posixPolicy?.umask, 0o022);

  NodeAssert.equal(host.processes.size, 0, "each command process must be reaped");
  NodeAssert.equal(wakes.size, 0, "command completion must leave no wake registrations");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      package: `${provenance.package}@${provenance.version}`,
      filesystem: "canonical KernelFileSystem over in-memory SQLite storage",
      cwd: "/work",
      commands: results,
      cwdValidation: {
        missingPwd: { pwd: results[2], relativeRead: results[5] },
        conflictingPwd: {
          pwd: conflictingPwd,
          relativeRead: relativeReadWithConflictingPwd,
        },
      },
      mkdirModes,
      metadata: {
        source: filesystem.getPosixMetadata("/work/source.txt"),
        createdDirectory: filesystem.getPosixMetadata("/work/relative-dir"),
        explicitParent: filesystem.getPosixMetadata("/work/nested-parent"),
        explicitLeaf: filesystem.getPosixMetadata("/work/nested-parent/leaf"),
        umaskParent: filesystem.getPosixMetadata("/work/private-parent"),
        umaskLeaf: filesystem.getPosixMetadata("/work/private-parent/leaf"),
        rootDecoy: filesystem.getPosixMetadata("/source.txt"),
      },
      processesRemaining: host.processes.size,
      wakesRemaining: wakes.size,
    })}\n`,
  );
} finally {
  await host.processes.dispose();
  filesystem.dispose();
  database.close();
  wakes.dispose();
}

async function run(command, args, extraEnv = {}) {
  const executable = `/bin/${command}`;
  const resolved = host.resolve(executable);
  NodeAssert.equal(resolved.status, "ok", `${executable} must resolve from the real registry`);
  if (resolved.status !== "ok") throw new Error(`Could not resolve ${executable}`);

  const piped = host.preparePiped({ filesystem }, { cwd: "/work" });
  const stdoutPromise = readStream(piped.stdout);
  const stderrPromise = readStream(piped.stderr);
  const input = piped.stdin.getWriter();
  try {
    await input.close();
  } finally {
    input.releaseLock();
  }

  let handle;
  try {
    const spawned = callKernel(host.backend(piped.prepared), "process.spawn", {
      program: resolved.value,
      args: [executable, ...args],
      env: { PATH: "/bin", ...extraEnv },
    });
    NodeAssert.equal(spawned.status, "ok", `${command} process admission must succeed`);
    if (spawned.status !== "ok") throw new Error(`${command} admission failed`);
    handle = spawned.value;

    const completed = await host.exitStatus(handle);
    NodeAssert.equal(
      completed.status,
      "ok",
      `${command} process must complete: ${JSON.stringify(completed)}; cause=${String(processes.failure)}`,
    );
    if (completed.status !== "ok") throw new Error(`${command} failed before returning status`);
    const reaped = host.reap(handle);
    NodeAssert.equal(reaped.status, "ok", `${command} process must be reaped`);
    handle = undefined;

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      command,
      args,
      exitCode: completed.value.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutEof: stdout.eof,
      stderrEof: stderr.eof,
    };
  } finally {
    if (handle !== undefined) host.reap(handle);
    await piped.prepared.release();
    await Promise.allSettled([stdoutPromise, stderrPromise]);
  }
}

async function probeMkdirMode() {
  const prepared = host.prepare({ filesystem }, { cwd: "/work" });
  const module = modules.mkdir;
  let memory;
  const runtime = createKernelAsyncWasi({
    filesystem: prepared.filesystem,
    wakes,
    agentOsPreopens: true,
    options: {
      version: "preview1",
      args: ["/bin/mkdir", "-m", "700", "/work/mode-probe"],
      env: { PWD: "/work" },
    },
  });
  const events = [];
  try {
    const imports = createKernelCoreutilsImports({
      module,
      memory: () => memory,
      fileSystem: prepared.filesystem,
      wakes,
      asyncMode: true,
    });
    const wasi = runtime.wasi.getImportObject();
    const hostFs = { ...imports.host_fs };
    for (const name of ["set_open_mode", "chmod"]) {
      const handler = hostFs[name];
      if (handler) {
        hostFs[name] = (...args) => {
          events.push({ namespace: "host_fs", name, args });
          return handler(...args);
        };
      }
    }
    const instance = new WebAssembly.Instance(module, {
      ...imports,
      ...wasi,
      host_fs: hostFs,
    });
    memory = instance.exports.memory;
    const exitCode = await runtime.wasi.start(instance);
    return {
      exitCode,
      mode: prepared.filesystem.getPosixMetadata("/work/mode-probe").mode,
      events,
    };
  } finally {
    await runtime.wasi.close();
    await prepared.release();
  }
}

function loadModule(command) {
  const record = provenance.commands?.[command];
  NodeAssert.ok(record, `provenance must pin ${command}`);
  const bytes = new Uint8Array(
    NodeFS.readFileSync(NodePath.join(artifactDirectory, `${command}.wasm`)),
  );
  NodeAssert.equal(bytes.byteLength, record.bytes, `${command} byte length must match provenance`);
  NodeAssert.equal(
    NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    record.sha256,
    `${command} hash must match provenance`,
  );
  return new WebAssembly.Module(bytes);
}

function writeFile(fileSystem, path, text, mode) {
  const fd = fileSystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC | KernelOpenFlags.O_WRONLY,
    mode,
  );
  try {
    fileSystem.write(fd, encoder.encode(text), null);
  } finally {
    fileSystem.close(fd);
  }
}

function readFile(fileSystem, path) {
  try {
    const fd = fileSystem.open(path, KernelOpenFlags.O_RDONLY);
    try {
      const bytes = new Uint8Array(Number(fileSystem.fstat(fd).size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = fileSystem.read(fd, bytes.subarray(offset), null);
        if (count === 0) break;
        offset += count;
      }
      return new TextDecoder().decode(bytes.subarray(0, offset));
    } finally {
      fileSystem.close(fd);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return { text: text + decoder.decode(), eof: true };
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function assertResult(result, stdout) {
  NodeAssert.equal(result.exitCode, 0, `${result.command} must exit successfully`);
  NodeAssert.equal(result.stdout, stdout, `${result.command} output must match`);
  NodeAssert.equal(result.stderr, "", `${result.command} must not write to stderr`);
  NodeAssert.equal(result.stdoutEof, true, `${result.command} stdout must reach EOF`);
  NodeAssert.equal(result.stderrEof, true, `${result.command} stderr must reach EOF`);
}
