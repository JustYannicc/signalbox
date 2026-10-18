// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off - the fixture verifies external byte output and fails stalled milestones without polling.
import * as NodeBuffer from "node:buffer";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "./KernelAbi.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { KernelCommandExecutor } from "./KernelCommandExecutor.ts";
import { KernelForwardingUnavailable } from "./KernelCommandForwarder.ts";
import { CodexExecProcesses } from "./CodexExecProcesses.ts";
import { CodexExecSessions } from "./CodexExecSessions.ts";
import { acceptCodexExecWebSocket } from "./CodexExecWebSocket.ts";
import { object } from "./CodexExecProtocol.ts";
import { ExecProofClient } from "./execServer/ProofClient.ts";
import type { Storage } from "./storage.ts";

export async function runCodexExecExecutionProof(
  storage: Storage,
  rg: WebAssembly.Module,
  lifetime: Pick<DurableObjectState, "waitUntil">,
) {
  const checks: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Execution proof failed: ${message}`);
    checks.push(message);
  };
  const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const expected = {
    args: ["argv-zero", "", "two words"],
    env: { EMPTY: "", SENTINEL: "env value" },
    cwd: "/workspace/a b",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  const expectedOutput = NodeBuffer.Buffer.concat([NodeBuffer.Buffer.from([0, 255]), bytes]);
  const expectedError = Uint8Array.of(254, 0, 10);
  const programs = new Map<string, KernelProgramBinding>();
  const register = (executable: string, binding: KernelProgramBinding) => {
    if (registry.register(binding.manifest).status !== "ok")
      throw new Error("Proof program registration failed");
    programs.set(executable, binding);
  };
  register("/bin/proof", {
    manifest: {
      name: "exec-proof",
      version: "1.0.0",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "exec-proof-js-v1",
    },
    implementation: {
      kind: "javascript",
      runInline: (context) => {
        const observed = new TextEncoder().encode(
          JSON.stringify({ args: context.args, env: context.env, cwd: context.filesystem.cwd }),
        );
        const output = NodeBuffer.Buffer.concat([NodeBuffer.Buffer.from([0, 255]), observed]);
        if (
          context.filesystem.write(1, output, null) !== output.length ||
          context.filesystem.write(2, expectedError, null) !== expectedError.length
        ) {
          throw new Error("Proof output failed");
        }
        return 17;
      },
    },
  });
  register("/bin/rg", {
    manifest: {
      name: "ripgrep",
      version: "0.3.3",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "exec-proof-rg-pinned",
    },
    implementation: { kind: "wasm", module: rg },
  });
  const host = new KernelProgramHost({ registry, wakes, programs });
  let forwarded = 0;
  const executor = new KernelCommandExecutor({
    host,
    filesystem,
    forwarder: {
      spawn: async () => {
        forwarded++;
        throw new KernelForwardingUnavailable(
          "WORKSPACE_NOT_READY",
          "Forwarding requires the canonical workspace from #1071",
        );
      },
    },
  });
  const sessions = new CodexExecSessions({
    environmentInfo: {
      shell: { name: "sh", path: "/bin/sh" },
      executorVersion: "0.0.0",
      capabilities: { tty: false },
    },
    createSession: (context) =>
      new CodexExecProcesses({
        spawn: executor.spawn,
        notify: context.notify,
        sessionSignal: context.signal,
        baseEnv: {},
      }),
    onCleanupError: (error) => {
      throw error;
    },
  });
  let client: ExecProofClient | undefined;
  let failure: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  let proofResult: { ok: true; checks: string[]; rgOutput: string } | undefined;
  try {
    for (const path of ["/workspace", "/workspace/a b"]) {
      try {
        filesystem.mkdir(path);
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    }
    const response = acceptCodexExecWebSocket(
      new Request("https://localhost/exec", { headers: { Upgrade: "websocket" } }),
      sessions,
      lifetime,
    );
    if (!response.webSocket) throw new Error("Proof upgrade returned no client socket");
    client = new ExecProofClient(response.webSocket);
    await milestone(
      "initialize",
      client.call("initialize", { clientName: "kernel-execution-proof" }),
    );
    client.notify("initialized");
    const run = async (
      processId: string,
      argv: string[],
      env: Record<string, string>,
      arg0?: string,
    ) => {
      const closed = client!.notification("process/closed", processId);
      await milestone(
        `${processId} start`,
        client!.call("process/start", {
          processId,
          argv,
          arg0,
          cwd: "file:///workspace/a%20b",
          env,
          tty: false,
        }),
      );
      await milestone(`${processId} closed`, closed);
      return object(
        await milestone(`${processId} read`, client!.call("process/read", { processId })),
      );
    };
    const result = await run(
      "js-proof",
      ["/bin/proof", "", "two words"],
      expected.env,
      "argv-zero",
    );
    const output = outputBytes(result, "stdout");
    const error = outputBytes(result, "stderr");
    check(
      output.equals(expectedOutput),
      "Registered program preserves argv0, empty args, cwd, env and stdout bytes",
    );
    check(
      error.equals(NodeBuffer.Buffer.from(expectedError)),
      "Stderr stays separate and byte exact",
    );
    check(
      result.exited === true && result.closed === true && result.exitCode === 17,
      "Exit and EOF are observable through process/read",
    );
    check(forwarded === 0, "Registered execution never enters the forwarding port");
    const wasm = await run("rg-proof", ["/bin/rg", "--version"], {});
    const rgOutput = outputBytes(wasm, "stdout").toString("utf8");
    check(
      wasm.exitCode === 0 && wasm.closed === true && rgOutput.includes("ripgrep"),
      "Pinned real ripgrep executes through the WebSocket process path",
    );
    proofResult = { ok: true, checks, rgOutput };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    for (const [label, cleanup] of [
      ["client close", () => client?.close()],
      ["session dispose", () => sessions.dispose()],
      ["filesystem dispose", () => filesystem.dispose()],
    ] as const) {
      try {
        await milestone(label, Promise.resolve().then(cleanup));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    wakes.dispose();
  }
  if (cleanupErrors.length > 0)
    throw new Error([...(failed ? [failure] : []), ...cleanupErrors].map(describeError).join("; "));
  if (failed) throw failure;
  if (proofResult === undefined) throw new Error("Execution proof returned no result");
  return proofResult;
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(describeError).join("; ")}`;
  if (error instanceof Error)
    return `${error.name}: ${error.message}${error.cause === undefined ? "" : ` (${describeError(error.cause)})`}`;
  return String(error);
}

async function milestone<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Execution proof stalled at ${label}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function outputBytes(result: Record<string, unknown>, stream: string) {
  if (!Array.isArray(result.chunks)) throw new Error("Proof read returned no output chunks");
  return NodeBuffer.Buffer.concat(
    result.chunks.flatMap((entry: unknown) => {
      const chunk = object(entry);
      if (chunk.stream !== stream) return [];
      if (typeof chunk.chunk !== "string") throw new Error("Proof output is not base64");
      return [NodeBuffer.Buffer.from(chunk.chunk, "base64")];
    }),
  );
}
