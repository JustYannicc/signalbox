// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off - this fixture proves the exec-server filesystem wire in a real Worker socket pair.
import * as NodeBuffer from "node:buffer";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "./KernelAbi.ts";
import { KernelCommandExecutor } from "./KernelCommandExecutor.ts";
import { KernelForwardingUnavailable } from "./KernelCommandForwarder.ts";
import { CodexExecHandler } from "./CodexExecHandler.ts";
import { CodexExecSessions } from "./CodexExecSessions.ts";
import { acceptCodexExecWebSocket } from "./CodexExecWebSocket.ts";
import { object } from "./CodexExecProtocol.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { ExecProofClient } from "./execServer/ProofClient.ts";
import type { Storage } from "./storage.ts";

const EXACT_PATH = "/codex-exec-fs-proof/nested/exact.txt";
const BINARY_PATH = "/codex-exec-fs-proof/binary.dat";
const EXACT_TEXT = "written through the exec-server filesystem RPC\n";
const REPLACED_BYTES = Uint8Array.of(0, 255, 128, 65, 0);
const FILESYSTEM_CLAIM =
  "Exec-server filesystem RPC and shared kernel filesystem only; this is not Codex apply_patch or a completed agent turn.";

type Phase = "write" | "persist";
type ProofResult = { ok: true; checks: string[]; sequence: string[]; claim: string };

/** Proves the exec-server filesystem wire and its SQL-backed state across facet requests. */
export async function runCodexExecFileSystemProof(
  storage: Storage,
  lifetime: Pick<DurableObjectState, "waitUntil">,
  phase?: Phase,
): Promise<ProofResult> {
  if (phase === "write") return runPhase(storage, lifetime, "write");
  if (phase === "persist") return runPhase(storage, lifetime, "persist");
  const first = await runPhase(storage, lifetime, "write");
  const second = await runPhase(storage, lifetime, "persist");
  return {
    ok: true,
    checks: [...first.checks, ...second.checks],
    sequence: [...first.sequence, ...second.sequence],
    claim: FILESYSTEM_CLAIM,
  };
}

async function runPhase(
  storage: Storage,
  lifetime: Pick<DurableObjectState, "waitUntil">,
  phase: Phase,
): Promise<ProofResult> {
  const checks: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Exec filesystem proof failed: ${message}`);
    checks.push(message);
  };
  const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const binding = readerProgramBinding();
  if (registry.register(binding.manifest).status !== "ok")
    throw new Error("Could not register the proof filesystem reader");
  const programs = new Map<string, KernelProgramBinding>([["/bin/fs-proof-reader", binding]]);
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
          "Unregistered executables require the canonical workspace",
        );
      },
    },
  });
  const sessions = new CodexExecSessions({
    environmentInfo: {
      shell: { name: "sh", path: "/bin/sh" },
      executorVersion: "filesystem-proof",
      capabilities: { tty: false },
    },
    createSession: ({ signal: sessionSignal, notify }) =>
      new CodexExecHandler({
        filesystem,
        spawn: executor.spawn,
        notify,
        sessionSignal,
        baseEnv: {},
        platformOs: "linux",
      }),
    onCleanupError: (error) => {
      throw error;
    },
  });

  let client: ExecProofClient | undefined;
  let failure: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  try {
    const response = acceptCodexExecWebSocket(
      new Request("https://localhost/exec", { headers: { Upgrade: "websocket" } }),
      sessions,
      lifetime,
    );
    if (!response.webSocket) throw new Error("Proof upgrade returned no client socket");
    client = new ExecProofClient(response.webSocket);
    await milestone("initialize", client.call("initialize", { clientName: "filesystem-proof" }));
    client.notify("initialized");

    if (phase === "write") {
      await proveWritePhase(client, filesystem, check);
    } else {
      await provePersistPhase(client, check);
    }
    check(forwarded === 0, "Registered execution never reached the unavailable forwarder");
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
    throw new Error(
      [...(failed && failure !== undefined ? [failure] : []), ...cleanupErrors]
        .map(describeError)
        .join("; "),
    );
  if (failed) throw failure;
  return {
    ok: true,
    checks,
    sequence: [phase === "write" ? "/proof" : "/proof-again"],
    claim: FILESYSTEM_CLAIM,
  };
}

async function proveWritePhase(
  client: ExecProofClient,
  filesystem: KernelFileSystem,
  check: (condition: boolean, message: string) => void,
) {
  const missing = "file:///codex-exec-fs-proof/missing.txt";
  await expectRpcError(client, "fs/getMetadata", { path: missing }, -32004, check);
  await expectRpcError(client, "fs/readFile", { path: missing }, -32004, check);

  await milestone(
    "nested recursive directory creation",
    client.call("fs/createDirectory", {
      path: "file:///codex-exec-fs-proof/nested",
      recursive: true,
    }),
  );
  const exactBytes = new TextEncoder().encode(EXACT_TEXT);
  await milestone(
    "ASCII file write",
    client.call("fs/writeFile", {
      path: guestPathToUri(EXACT_PATH),
      dataBase64: base64(exactBytes),
    }),
  );
  const read = object(
    await milestone(
      "ASCII file readback",
      client.call("fs/readFile", { path: guestPathToUri(EXACT_PATH) }),
    ),
  );
  check(
    read.dataBase64 === base64(exactBytes),
    "ASCII file bytes round-trip exactly over fs/writeFile and fs/readFile",
  );

  const metadata = object(
    await milestone(
      "file metadata",
      client.call("fs/getMetadata", { path: guestPathToUri(EXACT_PATH) }),
    ),
  );
  check(
    metadata.isFile === true &&
      metadata.isDirectory === false &&
      metadata.isSymlink === false &&
      metadata.size === exactBytes.byteLength,
    "Metadata reports the regular file and exact byte size",
  );
  check(
    typeof metadata.modifiedAtMs === "number" &&
      Number.isSafeInteger(metadata.modifiedAtMs) &&
      metadata.modifiedAtMs > 0,
    "Metadata exposes a positive modified time in milliseconds",
  );
  const canonical = object(
    await milestone(
      "canonical path",
      client.call("fs/canonicalize", { path: guestPathToUri(EXACT_PATH) }),
    ),
  );
  check(
    canonical.path === guestPathToUri(EXACT_PATH),
    "Canonicalize returns the file URI for the resolved path",
  );

  const oldBytes = new TextEncoder().encode("a longer old binary payload");
  await milestone(
    "initial binary write",
    client.call("fs/writeFile", {
      path: guestPathToUri(BINARY_PATH),
      dataBase64: base64(oldBytes),
    }),
  );
  await milestone(
    "binary replacement",
    client.call("fs/writeFile", {
      path: guestPathToUri(BINARY_PATH),
      dataBase64: base64(REPLACED_BYTES),
    }),
  );
  const binaryRead = object(
    await milestone(
      "binary readback",
      client.call("fs/readFile", { path: guestPathToUri(BINARY_PATH) }),
    ),
  );
  check(
    binaryRead.dataBase64 === base64(REPLACED_BYTES) &&
      filesystem.stat(BINARY_PATH).size === BigInt(REPLACED_BYTES.byteLength),
    "Binary replacement preserves bytes and truncates the old file tail",
  );

  await expectRpcError(
    client,
    "fs/writeFile",
    { path: guestPathToUri(EXACT_PATH), dataBase64: "%%%" },
    -32600,
    check,
  );
  const unchanged = object(
    await milestone(
      "invalid base64 preservation readback",
      client.call("fs/readFile", { path: guestPathToUri(EXACT_PATH) }),
    ),
  );
  check(
    unchanged.dataBase64 === base64(exactBytes),
    "Invalid base64 leaves the existing file unchanged",
  );

  const sandboxTarget = "file:///codex-exec-fs-proof/sandbox-must-not-exist.txt";
  await expectRpcError(
    client,
    "fs/writeFile",
    { path: sandboxTarget, dataBase64: base64("rejected"), sandbox: {} },
    -32600,
    check,
  );
  await expectRpcError(client, "fs/getMetadata", { path: sandboxTarget }, -32004, check);

  const closed = client.notification("process/closed", "shared-fs-reader");
  await milestone(
    "registered child start",
    client.call("process/start", {
      processId: "shared-fs-reader",
      argv: ["/bin/fs-proof-reader"],
      cwd: "file:///codex-exec-fs-proof",
      env: {},
      tty: false,
    }),
  );
  await milestone("registered child close", closed);
  const process = object(
    await milestone(
      "registered child output",
      client.call("process/read", { processId: "shared-fs-reader" }),
    ),
  );
  check(
    outputBytes(process, "stdout").equals(NodeBuffer.Buffer.from(exactBytes)) &&
      process.exited === true &&
      process.closed === true &&
      process.exitCode === 0,
    "A registered kernel process reads the exact RPC-written bytes through its shared filesystem",
  );
}

async function provePersistPhase(
  client: ExecProofClient,
  check: (condition: boolean, message: string) => void,
) {
  const exact = object(
    await milestone(
      "persisted ASCII readback",
      client.call("fs/readFile", { path: guestPathToUri(EXACT_PATH) }),
    ),
  );
  check(
    exact.dataBase64 === base64(new TextEncoder().encode(EXACT_TEXT)),
    "The first request's ASCII file survives a new filesystem and exec session on the same facet SQL storage",
  );
  const binary = object(
    await milestone(
      "persisted binary readback",
      client.call("fs/readFile", { path: guestPathToUri(BINARY_PATH) }),
    ),
  );
  check(
    binary.dataBase64 === base64(REPLACED_BYTES),
    "The first request's binary replacement survives the second request byte-for-byte",
  );
}

async function expectRpcError(
  client: ExecProofClient,
  method: string,
  params: unknown,
  code: number,
  check: (condition: boolean, message: string) => void,
) {
  let caught: unknown;
  try {
    await milestone(`${method} error ${code}`, client.call(method, params));
  } catch (error) {
    caught = error;
  }
  check(
    caught instanceof Error && caught.message.startsWith(`Exec-server ${code}:`),
    `${method} returns JSON-RPC error ${code}`,
  );
}

function readerProgramBinding(): KernelProgramBinding {
  return {
    manifest: {
      name: "filesystem-proof-reader",
      version: "1.0.0",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "filesystem-proof-reader-js-v1",
    },
    implementation: {
      kind: "javascript",
      runInline: ({ filesystem }) => {
        const descriptor = filesystem.open(EXACT_PATH, KernelOpenFlags.O_RDONLY);
        try {
          const bytes = NodeBuffer.Buffer.alloc(Number(filesystem.fstat(descriptor).size));
          let offset = 0;
          while (offset < bytes.byteLength) {
            const count = filesystem.read(descriptor, bytes.subarray(offset), null);
            if (count === 0) break;
            offset += count;
          }
          if (offset !== bytes.byteLength) throw new Error("Registered reader got a short file");
          if (filesystem.write(1, bytes, null) !== bytes.byteLength)
            throw new Error("Registered reader could not write its stdout");
          return 0;
        } finally {
          filesystem.close(descriptor);
        }
      },
    },
  };
}

function guestPathToUri(path: string) {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

function base64(value: string | Uint8Array) {
  return NodeBuffer.Buffer.from(value).toString("base64");
}

function outputBytes(result: Record<string, unknown>, stream: string) {
  if (!Array.isArray(result.chunks)) throw new Error("Proof process returned no output chunks");
  return NodeBuffer.Buffer.concat(
    result.chunks.flatMap((entry: unknown) => {
      const chunk = object(entry);
      if (chunk.stream !== stream) return [];
      if (typeof chunk.chunk !== "string") throw new Error("Proof process output is not base64");
      return [NodeBuffer.Buffer.from(chunk.chunk, "base64")];
    }),
  );
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
        timer = setTimeout(() => reject(new Error(`Filesystem proof stalled at ${label}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
