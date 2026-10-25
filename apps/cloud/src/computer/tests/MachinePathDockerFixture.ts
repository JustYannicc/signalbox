// @effect-diagnostics nodeBuiltinImport:off - the local proof owns its Docker process and pipes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import { build } from "esbuild";
import type {
  KernelCommandChild,
  KernelCommandForwarder,
} from "../../kernel/KernelCommandForwarder.ts";
import type { MachineFileLookupResponse, MachineFilesPort } from "../MachineFilesPort.ts";
import { MachineFileLookupError } from "../MachineFilesPort.ts";
import type { MachineFilesResult } from "@signalbox/runner-protocol/MachineFilesProtocol";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import { machinePathFixture, type MachinePathFixtureOptions } from "./MachinePathFixture.ts";

interface PendingLookup {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly resolve: (response: MachineFileLookupResponse) => void;
  readonly reject: (error: unknown) => void;
}

export async function machinePathDockerFixture(input: {
  readonly inventory: MachineProgramInventory;
  readonly bashModule: WebAssembly.Module;
  readonly attestImage?: boolean;
  readonly options?: Omit<MachinePathFixtureOptions, "inventory" | "files" | "spawn">;
}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-machine-path-"));
  const workspace = NodePath.join(root, "workspace");
  const bundleDirectory = NodePath.join(root, "bridge");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.mkdirSync(bundleDirectory, { recursive: true });
  NodeFS.chmodSync(root, 0o755);
  NodeFS.chmodSync(workspace, 0o777);
  NodeFS.chmodSync(bundleDirectory, 0o755);

  const bundlePath = NodePath.join(bundleDirectory, "runner-machine-files.mjs");
  let containerId: string;
  try {
    await buildMachineFilesBridge(bundlePath);
    containerId = docker([
      "run",
      "--detach",
      "--rm",
      "--network",
      "none",
      "--platform",
      input.inventory.platform,
      "--mount",
      `type=bind,src=${workspace},dst=/workspace`,
      "--mount",
      `type=bind,src=${bundleDirectory},dst=/tmp/signalbox-machine-path,readonly`,
      "--entrypoint",
      "/bin/sleep",
      input.inventory.imageRef,
      "900",
    ]);
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const bridge = NodeChildProcess.spawn(
    "docker",
    ["exec", "-i", containerId, "node", "/tmp/signalbox-machine-path/runner-machine-files.mjs"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdin = bridge.stdin;
  const stdout = bridge.stdout;
  const stderr = bridge.stderr;
  if (stdin === null || stdout === null || stderr === null) {
    bridge.kill("SIGKILL");
    docker(["rm", "--force", containerId]);
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw new Error("Could not start the production Runner machine file handler");
  }

  const pending = new Map<string, PendingLookup>();
  let nextRequest = 0;
  const generation = 1;
  let pristine = true;
  let bridgeError = "";
  let closed = false;
  stderr.on("data", (chunk: Uint8Array) => {
    bridgeError += new TextDecoder().decode(chunk);
  });
  const lines = NodeReadline.createInterface({ input: stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as MachineFilesResult;
    const operation = pending.get(message.requestId);
    if (operation === undefined) return;
    settle(message.requestId, () => {
      if (message.outcome.status === "error") {
        operation.reject(lookupError(message.outcome.code, message.outcome.message));
      } else {
        operation.resolve({ generation: message.generation, results: message.outcome.results });
      }
    });
  });
  const bridgeClosed = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
  bridge.on("error", (cause) => rejectPending(cause));
  bridge.on("close", (code, signal) => {
    rejectPending(
      new MachineFileLookupError(
        "RUNNER_DISCONNECTED",
        `Runner file bridge closed (${code ?? signal ?? "unknown"}). ${bridgeError}`.trim(),
      ),
    );
  });

  function settle(requestId: string, complete: () => void) {
    const operation = pending.get(requestId);
    if (operation === undefined) return;
    pending.delete(requestId);
    operation.signal.removeEventListener("abort", operation.abort);
    complete();
  }

  function rejectPending(error: unknown) {
    for (const [requestId, operation] of pending) {
      settle(requestId, () => operation.reject(error));
    }
  }

  const files: MachineFilesPort = {
    current: () => ({
      generation,
      pristine,
      ...(pristine && input.attestImage !== false
        ? { imageDigest: input.inventory.imageDigest }
        : {}),
    }),
    async markExecuted(requestedGeneration) {
      if (requestedGeneration !== generation)
        throw new MachineFileLookupError("STALE_GENERATION", "Runner machine generation changed.");
      pristine = false;
    },
    lookup(input, signal) {
      return new Promise<MachineFileLookupResponse>((resolve, reject) => {
        if (closed) {
          reject(new MachineFileLookupError("DISPOSED", "Machine file bridge is closed."));
          return;
        }
        if (signal.aborted) {
          reject(new MachineFileLookupError("ABORTED", "Machine file lookup was aborted."));
          return;
        }
        const requestId = `machine-path-${nextRequest++}`;
        const abort = () =>
          settle(requestId, () =>
            reject(new MachineFileLookupError("ABORTED", "Machine file lookup was aborted.")),
          );
        pending.set(requestId, { signal, abort, resolve, reject });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        stdin.write(
          `${JSON.stringify({ generation: input.generation, requestId, operations: input.operations })}\n`,
          (error) => {
            if (error) {
              settle(requestId, () =>
                reject(
                  new MachineFileLookupError(
                    "RUNNER_DISCONNECTED",
                    "Runner file bridge rejected lookup.",
                    { cause: error },
                  ),
                ),
              );
            }
          },
        );
      });
    },
  };

  const activeChildren = new Set<NodeChildProcess.ChildProcessWithoutNullStreams>();
  const spawn: KernelCommandForwarder["spawn"] = async (command, signal) => {
    signal.throwIfAborted();
    const args = ["exec", "-i", "--workdir", command.cwd];
    for (const [key, value] of Object.entries(command.env)) args.push("--env", `${key}=${value}`);
    args.push(containerId, command.executable, ...command.argv.slice(1));
    const child = NodeChildProcess.spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill("SIGKILL");
      throw new Error("Could not open native machine process streams");
    }
    activeChildren.add(child as NodeChildProcess.ChildProcessWithoutNullStreams);
    const exited = new Promise<{ exitCode: number; signal: number; coreDumped: boolean }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode) => {
          activeChildren.delete(child as NodeChildProcess.ChildProcessWithoutNullStreams);
          resolve({ exitCode: exitCode ?? 1, signal: 0, coreDumped: false });
        });
      },
    );
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    return {
      stdin: NodeStream.Writable.toWeb(child.stdin),
      stdout: toWebReadable(child.stdout),
      stderr: toWebReadable(child.stderr),
      exited: exited.finally(() => signal.removeEventListener("abort", onAbort)),
      signal: async (number) => {
        const name = number === 9 ? "SIGKILL" : number === 13 ? "SIGPIPE" : "SIGTERM";
        child.kill(name);
        return { status: "ok", value: undefined };
      },
      dispose: async () => {
        if (activeChildren.has(child as NodeChildProcess.ChildProcessWithoutNullStreams))
          child.kill("SIGKILL");
        await exited;
      },
    } satisfies KernelCommandChild;
  };

  let fixture: ReturnType<typeof machinePathFixture>;
  try {
    fixture = machinePathFixture(input.bashModule, {
      ...input.options,
      inventory: input.inventory,
      files,
      spawn,
    });
  } catch (error) {
    stdin.end();
    bridge.kill("SIGTERM");
    docker(["rm", "--force", containerId]);
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    ...fixture,
    native(
      executable: string,
      args: readonly string[],
      env: Readonly<Record<string, string>> = {},
    ) {
      const dockerArgs = ["exec", "--workdir", "/workspace"];
      for (const [key, value] of Object.entries(env)) dockerArgs.push("--env", `${key}=${value}`);
      dockerArgs.push(containerId, executable, ...args);
      const result = NodeChildProcess.spawnSync("docker", dockerArgs, { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status === null)
        throw new Error(`Native command was signaled: ${JSON.stringify(result)}`);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await fixture.close();
      } finally {
        stdin.end();
        for (const child of activeChildren) child.kill("SIGKILL");
        await bridgeClosed;
        docker(["rm", "--force", containerId]);
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

async function buildMachineFilesBridge(outfile: string) {
  const handler = NodePath.resolve(
    import.meta.dirname,
    "../../../../../apps/server/src/signalbox/runner/RunnerMachineFiles.ts",
  );
  const contents = [
    `import * as readline from "node:readline";`,
    `import * as Effect from "effect/Effect";`,
    `import * as Layer from "effect/Layer";`,
    `import * as RunnerNativeFileSystem from ${JSON.stringify(NodePath.join(NodePath.dirname(handler), "RunnerNativeFileSystem.ts"))};`,
    `import * as RunnerMachineFiles from ${JSON.stringify(handler)};`,
    `const host = await Effect.runPromise(Effect.map(RunnerMachineFiles.RunnerMachineFiles, value => value).pipe(Effect.provide(RunnerMachineFiles.layer.pipe(Layer.provide(RunnerNativeFileSystem.layer)))));`,
    `const lines = readline.createInterface({ input: process.stdin });`,
    `for await (const line of lines) {`,
    `  const input = JSON.parse(line);`,
    `  const request = { type: "machine.files.request", ...input };`,
    `  const result = await Effect.runPromise(host.lookup(request).pipe(Effect.catchTags({ RunnerMachineFilesError: () => Effect.succeed(RunnerMachineFiles.lookupFailedResult(request)) })));`,
    `  process.stdout.write(JSON.stringify(result) + "\\n");`,
    `}`,
  ].join("\n");
  await build({
    stdin: {
      contents,
      loader: "ts",
      resolveDir: NodePath.resolve(import.meta.dirname, "../../../../../"),
      sourcefile: "machine-files-bridge.ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    nodePaths: [NodePath.resolve(import.meta.dirname, "../../../../../apps/server/node_modules")],
    logLevel: "silent",
  });
}

function docker(args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync("docker", [...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`docker ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function toWebReadable(
  source: InstanceType<typeof NodeStream.Readable>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
      source.once("end", () => controller.close());
      source.once("error", (error: Error) => controller.error(error));
    },
    cancel() {
      source.destroy();
    },
  });
}

function lookupError(code: string, message: string) {
  return new MachineFileLookupError(
    code === "stale_generation"
      ? "STALE_GENERATION"
      : code === "frame_too_large"
        ? "FRAME_TOO_LARGE"
        : "LOOKUP_FAILED",
    message,
  );
}
