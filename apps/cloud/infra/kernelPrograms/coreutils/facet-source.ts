// @effect-diagnostics globalDate:off - Durable Object timestamps are the proof database clock.
import { DurableObject } from "cloudflare:workers";
import bash from "./bash.wasm";
import busybox from "./busybox.wasm";
import catBase64 from "./cat-bytes.txt";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
  type KernelResult,
} from "../../../src/kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../../src/kernel/KernelBusyboxProgram.ts";
import {
  KERNEL_BASH_ARTIFACT,
  createKernelBashProgram,
} from "../../../src/kernel/KernelBashProgram.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import {
  KernelProcessTable,
  type KernelLaunchedChild,
  type KernelProcessIdentity,
} from "../../../src/kernel/KernelProcessTable.ts";
import { registerKernelBusyboxCat } from "../../../src/kernel/KernelBusyboxPrograms.ts";

const BASH_ARTIFACT = KERNEL_BASH_ARTIFACT;
const BUSYBOX_ARTIFACT = KERNEL_BUSYBOX_ARTIFACT;
const SOURCE_INVENTORY = "__KERNEL_COREUTILS_PROOF_SOURCE_INVENTORY__";
const CREDENTIALS = Object.freeze({ uid: 1000, gid: 1000, euid: 1000, egid: 1000 });
const BASH_CREDENTIALS = Object.freeze({
  ...CREDENTIALS,
  umask: 0o022,
  hostname: "kernel-proof",
});
const SCRIPT = "umask 077; echo payload > /workspace/result && cat /workspace/result";

class RecordingProcessTable extends KernelProcessTable {
  readonly pids: number[] = [];

  override spawn(
    parent: KernelHandle<"process"> | undefined,
    launch: (identity: KernelProcessIdentity) => KernelLaunchedChild,
    release: () => void | Promise<void>,
    options: { readonly processGroupId?: number } = {},
  ): KernelResult<{ readonly handle: KernelHandle<"process">; readonly pid: number }> {
    const result = super.spawn(parent, launch, release, options);
    if (result.status === "ok") this.pids.push(result.value.pid);
    return result;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function readFile(filesystem: KernelFileSystem, path: string) {
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
}

function writeFile(filesystem: KernelFileSystem, path: string, bytes: Uint8Array, mode: number) {
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC | KernelOpenFlags.O_WRONLY,
    mode,
  );
  try {
    filesystem.write(fd, bytes, null);
  } finally {
    filesystem.close(fd);
  }
}

export class KernelCoreutilsFacet extends DurableObject {
  override async fetch(request: Request) {
    if (!["/proof", "/proof-again"].includes(new URL(request.url).pathname)) {
      return new Response("Not found", { status: 404 });
    }

    const checks: Array<{ name: string; ok: boolean; details?: unknown; error?: string }> = [];
    const check = async (name: string, run: () => Promise<unknown> | unknown) => {
      try {
        checks.push({ name, ok: true, details: await run() });
      } catch (error) {
        checks.push({
          name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const wakes = new KernelWakeRegistry();
    const database = createFacetSqliteStorage(
      this.ctx.storage,
      () => BigInt(Date.now()) * 1_000_000n,
    );
    try {
      try {
        database.posix.initialize(database.root, { mode: 0o755, uid: 1000, gid: 1000 });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }
      const filesystem = new KernelFileSystem({
        mounts: [{ path: "/", storage: database }],
        posix: { credentials: CREDENTIALS, umask: 0o022 },
      });
      let host: KernelProgramHost | undefined;
      try {
        for (const path of ["/workspace", "/bin"]) {
          try {
            filesystem.mkdir(path);
          } catch (error) {
            if (
              !(error && typeof error === "object" && "code" in error && error.code === "EEXIST")
            ) {
              throw error;
            }
          }
        }
        const catBytes = Uint8Array.from(atob(catBase64), (character) => character.charCodeAt(0));
        assert(
          catBytes.byteLength === BUSYBOX_ARTIFACT.bytes,
          `BusyBox cat payload length differs: ${catBytes.byteLength}`,
        );
        writeFile(filesystem, "/bin/cat", catBytes, 0o755);

        const processes = new RecordingProcessTable({ wakes });
        const registry = new KernelProgramRegistry();
        const busyboxPrograms = registerKernelBusyboxCat(registry, busybox);
        const bashManifest = Object.freeze({
          name: "@nimbus/bash",
          version: BASH_ARTIFACT.version,
          abiVersion: ABI_VERSION,
          requiredCapabilities: Object.freeze([
            "process.spawn",
            "process.wait",
            "process.signal",
          ] as const),
          entrypoint: `nimbus-bash:${BASH_ARTIFACT.sha256}`,
        });
        assert(registry.register(bashManifest).status === "ok", "GNU Bash registration failed");
        const programs = new Map(busyboxPrograms);
        programs.set("/bin/bash", {
          manifest: bashManifest,
          implementation: createKernelBashProgram({
            module: bash,
            credentials: { ...BASH_CREDENTIALS },
          }),
        });
        host = new KernelProgramHost({ registry, wakes, programs, processes });

        await check("GNU Bash writes, then pinned BusyBox cat reads the same file", async () => {
          const prepared = host!.preparePiped({ filesystem }, { cwd: "/workspace" });
          const stdoutPromise = readStream(prepared.stdout);
          const stderrPromise = readStream(prepared.stderr);
          let handle: KernelHandle<"process"> | undefined;
          try {
            const input = prepared.stdin.getWriter();
            try {
              await input.close();
            } finally {
              input.releaseLock();
            }
            const resolved = host!.resolve("/bin/bash");
            assert(resolved.status === "ok", "GNU Bash did not resolve");
            const spawned = callKernel(host!.backend(prepared.prepared), "process.spawn", {
              program: resolved.value,
              args: ["/bin/bash", "-c", SCRIPT],
              env: { PATH: "/bin", PWD: "/workspace" },
            });
            assert(
              spawned.status === "ok",
              `GNU Bash admission failed: ${JSON.stringify(spawned)}`,
            );
            handle = spawned.value;
            const identity = host!.processes.info(handle!);
            assert(
              identity.status === "ok",
              `GNU Bash PID lookup failed: ${JSON.stringify(identity)}`,
            );
            const bashPid = identity.value.pid;
            const exited = await host!.exitStatus(handle);
            assert(exited.status === "ok", `GNU Bash failed: ${JSON.stringify(exited)}`);
            assert(
              exited.value.exitCode === 0 && exited.value.signal === 0,
              `Bash exit: ${JSON.stringify(exited.value)}`,
            );
            const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
            assert(
              stdout.text === "payload\n",
              `Unexpected stdout: ${JSON.stringify(stdout.text)}`,
            );
            assert(stderr.text === "", `Unexpected stderr: ${JSON.stringify(stderr.text)}`);
            assert(stdout.eof && stderr.eof, "Output streams did not reach EOF");
            assert(host!.reap(handle).status === "ok", "GNU Bash process could not be reaped");
            handle = undefined;

            const file = readFile(filesystem, "/workspace/result");
            const metadata = filesystem.getPosixMetadata("/workspace/result");
            const pids = [...processes.pids];
            assert(file === "payload\n", "Redirected file contents differ");
            assert(metadata.mode === 0o600, `Expected mode 0600, got ${metadata.mode.toString(8)}`);
            assert(
              metadata.uid === 1000 && metadata.gid === 1000,
              "Created file owner differs from policy",
            );
            assert(filesystem.posixPolicy?.umask === 0o022, "Parent filesystem umask changed");
            assert(
              pids.length === 2 && pids[0] === bashPid && pids[1]! > bashPid,
              `Unexpected PIDs: ${JSON.stringify(pids)}`,
            );
            assert(processes.size === 0, `Process records remain: ${processes.size}`);
            assert(wakes.size === 0, `Wake registrations remain: ${wakes.size}`);
            return {
              argv: ["/bin/bash", "-c", SCRIPT],
              cwd: "/workspace",
              env: { PATH: "/bin", PWD: "/workspace" },
              pids: { bash: pids[0]!, busyboxCat: pids[1]! },
              stdout: stdout.text,
              stdoutEof: stdout.eof,
              stderr: stderr.text,
              stderrEof: stderr.eof,
              file: { path: "/workspace/result", contents: file, ...metadata },
              parentUmask: filesystem.posixPolicy?.umask,
              processes: processes.size,
              wakes: wakes.size,
            };
          } finally {
            await prepared.prepared.release();
            if (handle !== undefined) host!.reap(handle);
            await Promise.allSettled([stdoutPromise, stderrPromise]);
          }
        });
        await check("root metadata and static artifact pins", () => {
          const root = database.posix.get(database.root);
          assert(
            root.mode === 0o755 && root.uid === 1000 && root.gid === 1000,
            "Root POSIX metadata differs",
          );
          assert(BASH_ARTIFACT.bytes === 3_890_330, "GNU Bash artifact pin changed");
          assert(BUSYBOX_ARTIFACT.bytes === 241_159, "BusyBox artifact pin changed");
          return { root, artifacts: { bash: BASH_ARTIFACT, busybox: BUSYBOX_ARTIFACT } };
        });
        await check("processes and wakeups are drained", () => {
          assert(
            host!.processes.size === 0,
            `Process table retained ${host!.processes.size} entries`,
          );
          assert(wakes.size === 0, `Wake registry retained ${wakes.size} entries`);
          return { processes: host!.processes.size, wakes: wakes.size };
        });
      } finally {
        const disposed = await host?.processes.dispose();
        if (disposed && disposed.status !== "ok") throw new Error(JSON.stringify(disposed));
        filesystem.dispose();
      }
    } catch (error) {
      checks.push({
        name: "facet setup",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      wakes.dispose();
    }

    return Response.json({
      ok: checks.length > 0 && checks.every((check) => check.ok),
      checks,
      artifacts: { bash: BASH_ARTIFACT, busybox: BUSYBOX_ARTIFACT },
      sources: SOURCE_INVENTORY,
      staticModules: true,
      outbound: false,
    });
  }
}
