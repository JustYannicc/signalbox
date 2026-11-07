// @effect-diagnostics nodeBuiltinImport:off - Loads the hash-pinned Bash artifact for the product-path regression.
// @effect-diagnostics globalTimers:off - The deadline detects a broken child wait; it does not drive successful completion.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { MachineFileSourceState, MachineFilesPort } from "../MachineFilesPort.ts";
import { makeThreadExecForwarder } from "../../thread/ThreadExecForwarder.ts";
import { createChildBash } from "../ChildBash.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createProductComputer } from "../ProductComputer.ts";
import { commandProgramCodes } from "../commandGatewayTesting.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { sqliteFixture } from "../sqliteTesting.ts";
import { bashCredentials } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact = NodeProcess.env.SIGNALBOX_BASH_ARTIFACT;
if (artifact === undefined && NodeProcess.env.SIGNALBOX_REQUIRE_UNAVAILABLE_BASH_ARTIFACT === "1")
  throw new Error("The unavailable-machine proof requires the pinned Bash artifact");
const bytes = artifact === undefined ? undefined : NodeFS.readFileSync(artifact);
if (
  bytes !== undefined &&
  (bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256)
)
  throw new Error("The Bash artifact does not match its pin");

describe.skipIf(bytes === undefined)("unavailable machine through ProductComputer Bash", () => {
  it.each(["absent", "pristine", "disconnected"] as const)(
    "continues the pipeline and loop with %s machine state",
    async (kind) => {
      if (bytes === undefined) throw new Error("Pinned Bash is required");
      const module = new WebAssembly.Module(bytes);
      const inventory = machineInventoryFixture([
        { path: "/bin/bash", mode: 0o755, uid: 0, gid: 0 },
        { path: "/usr/bin/probe", mode: 0o755, uid: 0, gid: 0 },
      ]);
      let state: MachineFileSourceState =
        kind === "absent"
          ? {
              generation: null,
              generationAbsent: true,
              pristine: true,
              imageDigest: inventory.imageDigest,
            }
          : { generation: 1, pristine: true, imageDigest: inventory.imageDigest };
      const lookup = vi.fn(async () => {
        throw new Error("No machine is connected for file lookup");
      });
      const markExecuted = vi.fn(async () => {
        state = { ...state, pristine: false };
      });
      const files: MachineFilesPort = { current: () => state, markExecuted, lookup };
      const release = vi.fn(async () => undefined);
      const forwarder = makeThreadExecForwarder({
        beforeStart: (generation) => files.markExecuted(generation),
        ...(kind === "disconnected"
          ? {
              lease: {
                acquire: async () => ({ generation: 1, connection: 1, release }),
              },
            }
          : {}),
      });
      const spawn = vi.fn(forwarder.spawn);
      const database = sqliteFixture();
      const storage = createFacetSqliteStorage(database.storage, () => 1n);
      storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
      const filesystem = new KernelFileSystem({
        mounts: [{ path: "/", storage }],
        posix: { credentials: bashCredentials, umask: 0o022 },
      });
      filesystem.mkdir("/work");
      filesystem.chdir("/work");
      const wakes = new KernelWakeRegistry();
      const controller = new AbortController();
      const outcomes: unknown[] = [];
      const computer = createProductComputer({
        threadId: "unavailable-machine-bash",
        filesystem,
        wakes,
        signal: controller.signal,
        capacity: new ChildWorkerCapacity(4, {
          owner: "test/unavailable-machine-bash",
          RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
        }),
        programs: commandProgramCodes(),
        machineInventory: inventory,
        machine: () => ({ files, spawn }),
        loader: {
          async run(input, target) {
            const invocation = target as unknown as { host(): object; stopped(): void };
            const host = invocation.host() as KernelBashPort & {
              metadata(): {
                pid: number;
                credentials: typeof bashCredentials;
                residentByteLimit: number;
              };
              forkSnapshot(): Promise<KernelBashForkSource | undefined>;
            };
            const bash = createChildBash({
              module,
              ...host.metadata(),
              port: host,
              args: input.command.argv,
              env: input.command.env,
              snapshot: await host.forkSnapshot(),
            });
            try {
              const result = await bash.run();
              outcomes.push({ executable: input.command.executable, ...result });
              return result;
            } catch (error) {
              outcomes.push({
                error: String(error),
                cause: error instanceof Error ? String(error.cause) : "",
              });
              throw error;
            } finally {
              await bash.drain();
              invocation.stopped();
            }
          },
        },
      });
      const timer = setTimeout(
        () => controller.abort(new Error(`Bash did not settle: ${JSON.stringify(outcomes)}`)),
        2_000,
      );
      try {
        const child = await computer.exec(
          {
            executable: "/bin/bash",
            argv: [
              "bash",
              "-c",
              String.raw`
for f in a b c; do
  printf '%s:' "$f"
  printf x | /usr/bin/probe
  printf 'status=%s;' "$?"
  /usr/bin/probe | bash -c 'printf right'
  printf '=%s;' "$?"
  bash -c 'printf local'
  printf ';after\n'
done
`,
            ],
            cwd: "/work",
            env: { PATH: "/bin:/usr/bin", LC_ALL: "C" },
          },
          controller.signal,
          undefined,
        );
        await child.stdin.getWriter().close();
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ stdout, status, outcomes }).toMatchObject({
          stdout:
            "a:status=126;right=0;local;after\nb:status=126;right=0;local;after\nc:status=126;right=0;local;after\n",
          status: { exitCode: 0, signal: 0 },
        });
        expect(stderr.match(/RUNNER_NOT_READY/g)).toHaveLength(6);
        expect(spawn).toHaveBeenCalledTimes(6);
        expect(markExecuted).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
        expect(state.pristine).toBe(true);
        expect(release).toHaveBeenCalledTimes(kind === "disconnected" ? 6 : 0);
        await child.dispose();
      } finally {
        clearTimeout(timer);
        controller.abort();
        await computer.close();
        await forwarder.dispose();
        wakes.dispose();
        filesystem.dispose();
        database.close();
      }
    },
  );
});
