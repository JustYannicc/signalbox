// @effect-diagnostics globalDate:off - Durable Object timestamps are the proof database clock.
import { DurableObject } from "cloudflare:workers";
import cat from "./bin/cat.wasm";
import echo from "./bin/echo.wasm";
import printf from "./bin/printf.wasm";
import ls from "./bin/ls.wasm";
import mkdir from "./bin/mkdir.wasm";
import rm from "./bin/rm.wasm";
import cp from "./bin/cp.wasm";
import mv from "./bin/mv.wasm";
import pwd from "./bin/pwd.wasm";
import head from "./bin/head.wasm";
import tail from "./bin/tail.wasm";
import wc from "./bin/wc.wasm";
import uniq from "./bin/uniq.wasm";
import {
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
} from "../../../src/kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import { KernelProcessTable } from "../../../src/kernel/KernelProcessTable.ts";
import {
  KERNEL_COREUTILS_COMMANDS,
  registerKernelCoreutilsPrograms,
} from "../../../src/kernel/KernelCoreutilsPrograms.ts";
import type { KernelCoreutilsModules } from "../../../src/kernel/KernelCoreutilsPrograms.ts";

const STATIC_MODULES = {
  cat,
  echo,
  printf,
  ls,
  mkdir,
  rm,
  cp,
  mv,
  pwd,
  head,
  tail,
  wc,
  uniq,
} satisfies KernelCoreutilsModules;
const CREDENTIALS = Object.freeze({ uid: 1000, gid: 1000, euid: 1000, egid: 1000 });
const SOURCE_INVENTORY = "__KERNEL_COREUTILS_PROGRAM_FACET_SOURCE_INVENTORY__";
const encoder = new TextEncoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errno(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function assertResult(
  result: Awaited<ReturnType<KernelCoreutilsProgramFacet["run"]>>,
  expectedStdout: string,
) {
  assert(result.exitCode === 0, `${result.command} exited ${result.exitCode}`);
  assert(
    result.stdout === expectedStdout,
    `${result.command} stdout mismatch: ${JSON.stringify(result.stdout)}`,
  );
  assert(result.stderr === "", `${result.command} wrote stderr: ${JSON.stringify(result.stderr)}`);
  assert(result.stdoutEof && result.stderrEof, `${result.command} streams did not reach EOF`);
}

async function readStream(stream: ReadableStream<Uint8Array>) {
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

export class KernelCoreutilsProgramFacet extends DurableObject {
  async run(
    command: string,
    args: readonly string[],
    host: KernelProgramHost,
    filesystem: KernelFileSystem,
    cwd: string,
    env: Readonly<Record<string, string>> = {},
  ) {
    const executable = `/bin/${command}`;
    const resolved = host.resolve(executable);
    assert(resolved.status === "ok", `${executable} must resolve from the static registry`);
    if (resolved.status !== "ok") throw new Error(`Could not resolve ${executable}`);

    const piped = host.preparePiped({ filesystem }, { cwd });
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
        env: { PATH: "/bin", ...env },
      });
      assert(spawned.status === "ok", `${command} admission failed: ${JSON.stringify(spawned)}`);
      if (spawned.status !== "ok") throw new Error(`${command} admission failed`);
      handle = spawned.value;
      const completed = await host.exitStatus(handle);
      assert(completed.status === "ok", `${command} failed: ${JSON.stringify(completed)}`);
      if (completed.status !== "ok") throw new Error(`${command} failed before returning status`);
      assert(host.reap(handle).status === "ok", `${command} process could not be reaped`);
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

  override async fetch(request: Request) {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/proof" && pathname !== "/proof-again") {
      return new Response("Not found", { status: 404 });
    }

    const wakes = new KernelWakeRegistry();
    const database = createFacetSqliteStorage(
      this.ctx.storage,
      () => BigInt(Date.now()) * 1_000_000n,
    );
    let host: KernelProgramHost | undefined;
    let filesystem: KernelFileSystem | undefined;
    try {
      try {
        database.posix.initialize(database.root, { mode: 0o755, uid: 1000, gid: 1000 });
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
      filesystem = new KernelFileSystem({
        mounts: [{ path: "/", storage: database }],
        posix: { credentials: CREDENTIALS, umask: 0o022 },
      });
      let runId = Date.now();
      let cwd: string;
      for (;;) {
        cwd = `/coreutils-${runId}`;
        try {
          filesystem.mkdir(cwd);
          break;
        } catch (error) {
          if (errno(error) !== "EEXIST") throw error;
          runId += 1;
        }
      }
      const source = `${cwd}/source.txt`;
      const rootDecoy = "/source.txt";
      writeFile(filesystem, source, "alpha line\nalpha line\nbeta\n", 0o640);
      writeFile(filesystem, rootDecoy, "wrong root decoy\n", 0o600);

      const registry = new KernelProgramRegistry();
      const programs = registerKernelCoreutilsPrograms(registry, STATIC_MODULES);
      assert(
        programs.size === KERNEL_COREUTILS_COMMANDS.length,
        "not all pinned commands registered",
      );
      const processes = new KernelProcessTable({ wakes });
      host = new KernelProgramHost({ registry, wakes, processes, programs });

      const results = [];
      results.push(await this.run("echo", ["coreutils echo"], host, filesystem, cwd));
      results.push(await this.run("printf", ["%s\\n", "coreutils printf"], host, filesystem, cwd));
      results.push(await this.run("pwd", [], host, filesystem, cwd));
      results.push(await this.run("mkdir", ["-m", "700", "relative-dir"], host, filesystem, cwd));
      results.push(await this.run("ls", ["-1", "."], host, filesystem, cwd));
      results.push(await this.run("cat", ["source.txt"], host, filesystem, cwd));
      results.push(await this.run("head", ["-n", "1", "source.txt"], host, filesystem, cwd));
      results.push(await this.run("tail", ["-n", "1", "source.txt"], host, filesystem, cwd));
      results.push(await this.run("wc", ["-l", "-w", "-c", "source.txt"], host, filesystem, cwd));
      results.push(await this.run("uniq", ["source.txt"], host, filesystem, cwd));
      results.push(await this.run("cp", ["source.txt", "copied.txt"], host, filesystem, cwd));
      assert(
        readFile(filesystem, `${cwd}/copied.txt`) === "alpha line\nalpha line\nbeta\n",
        "cp did not create the copied file",
      );
      assert(
        readFile(filesystem, `${cwd}/source.txt`) === "alpha line\nalpha line\nbeta\n",
        "cp changed its source",
      );
      results.push(await this.run("mv", ["copied.txt", "moved.txt"], host, filesystem, cwd));
      assert(
        readFile(filesystem, `${cwd}/copied.txt`) === undefined,
        "mv left the source file behind",
      );
      assert(
        readFile(filesystem, `${cwd}/moved.txt`) === "alpha line\nalpha line\nbeta\n",
        "mv did not preserve the moved file",
      );
      results.push(await this.run("rm", ["moved.txt"], host, filesystem, cwd));
      assert(readFile(filesystem, `${cwd}/moved.txt`) === undefined, "rm left the moved file");

      const conflictingPwd = await this.run("pwd", [], host, filesystem, cwd, { PWD: "/" });
      assertResult(conflictingPwd, `${cwd}\n`);
      const relativeReadWithConflictingPwd = await this.run(
        "cat",
        ["source.txt"],
        host,
        filesystem,
        cwd,
        { PWD: "/" },
      );
      assertResult(relativeReadWithConflictingPwd, "alpha line\nalpha line\nbeta\n");
      assert(results.length === KERNEL_COREUTILS_COMMANDS.length, "command proof count differs");
      assertResult(results[0]!, "coreutils echo\n");
      assertResult(results[1]!, "coreutils printf\n");
      assertResult(results[2]!, `${cwd}\n`);
      assertResult(results[3]!, "");
      assert(results[4]!.stdout.includes("relative-dir"), "ls did not see the new directory");
      assertResult(results[5]!, "alpha line\nalpha line\nbeta\n");
      assertResult(results[6]!, "alpha line\n");
      assertResult(results[7]!, "beta\n");
      assert(/^\s*3\s+5\s+27\s+source\.txt\n$/.test(results[8]!.stdout), "wc result differs");
      assertResult(results[9]!, "alpha line\nbeta\n");
      assertResult(results[10]!, "");
      assertResult(results[11]!, "");
      assertResult(results[12]!, "");
      assert(
        filesystem.getPosixMetadata(`${cwd}/relative-dir`).mode === 0o700,
        "mkdir -m mode differs",
      );
      assert(
        readFile(filesystem, `${cwd}/source.txt`) === "alpha line\nalpha line\nbeta\n",
        "cp/mv/rm changed source",
      );
      assert(readFile(filesystem, `${cwd}/moved.txt`) === undefined, "rm left the moved file");
      assert(
        readFile(filesystem, rootDecoy) === "wrong root decoy\n",
        "cwd-relative read escaped its directory",
      );

      const modeResult = await this.run(
        "mkdir",
        ["-p", "-m", "711", "nested-parent/leaf"],
        host,
        filesystem,
        cwd,
      );
      assertResult(modeResult, "");
      assert(
        filesystem.getPosixMetadata(`${cwd}/nested-parent`).mode === 0o755,
        "mkdir -p parent mode differs",
      );
      assert(
        filesystem.getPosixMetadata(`${cwd}/nested-parent/leaf`).mode === 0o711,
        "mkdir -p leaf mode differs",
      );
      const previousUmask = filesystem.setUmask(0o077);
      let privateResult;
      try {
        privateResult = await this.run(
          "mkdir",
          ["-p", "private-parent/leaf"],
          host,
          filesystem,
          cwd,
        );
      } finally {
        filesystem.setUmask(previousUmask);
      }
      assertResult(privateResult, "");
      assert(
        filesystem.getPosixMetadata(`${cwd}/private-parent`).mode === 0o700,
        "umask did not shape parent mode",
      );
      assert(
        filesystem.getPosixMetadata(`${cwd}/private-parent/leaf`).mode === 0o700,
        "umask did not shape leaf mode",
      );
      assert(processes.size === 0, "process records remain after the sweep");
      assert(wakes.size === 0, "wake registrations remain after the sweep");

      return Response.json({
        ok: true,
        commands: results,
        cwdValidation: {
          missingPwd: { pwd: results[2], relativeRead: results[5] },
          conflictingPwd: {
            pwd: conflictingPwd,
            relativeRead: relativeReadWithConflictingPwd,
          },
        },
        mkdirModes: {
          explicit: filesystem.getPosixMetadata(`${cwd}/relative-dir`),
          recursiveParent: filesystem.getPosixMetadata(`${cwd}/nested-parent`),
          recursiveLeaf: filesystem.getPosixMetadata(`${cwd}/nested-parent/leaf`),
          umaskParent: filesystem.getPosixMetadata(`${cwd}/private-parent`),
          umaskLeaf: filesystem.getPosixMetadata(`${cwd}/private-parent/leaf`),
        },
        source: { path: source, bytes: filesystem.stat(source).size.toString() },
        rootDecoy: { path: rootDecoy, contents: readFile(filesystem, rootDecoy) },
        processesRemaining: processes.size,
        wakesRemaining: wakes.size,
        commandsRegistered: KERNEL_COREUTILS_COMMANDS,
        sourceInventory: SOURCE_INVENTORY,
      });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      const disposed = await host?.processes.dispose();
      filesystem?.dispose();
      wakes.dispose();
      if (disposed && disposed.status !== "ok") throw new Error(JSON.stringify(disposed));
    }
  }
}

function writeFile(filesystem: KernelFileSystem, path: string, text: string, mode: number) {
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC | KernelOpenFlags.O_WRONLY,
    mode,
  );
  try {
    filesystem.write(fd, encoder.encode(text), null);
  } finally {
    filesystem.close(fd);
  }
}

function readFile(filesystem: KernelFileSystem, path: string) {
  try {
    const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
    try {
      const bytes = new Uint8Array(Number(filesystem.fstat(fd).size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = filesystem.read(fd, bytes.subarray(offset), null);
        if (count === 0) break;
        offset += count;
      }
      return new TextDecoder().decode(bytes.subarray(0, offset));
    } finally {
      filesystem.close(fd);
    }
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}
