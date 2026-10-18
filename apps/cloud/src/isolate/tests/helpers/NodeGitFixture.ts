// @effect-diagnostics nodeBuiltinImport:off - isolated SQLite fixtures, never live userdata.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import { ABI_VERSION, callKernel, KernelProgramRegistry } from "../../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type {
  KernelAsyncProgram,
  KernelAsyncProgramContext,
} from "../../../kernel/KernelAsyncProgram.ts";
import { KernelProgramHost } from "../../../kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../../kernel/KernelWakeRegistry.ts";
import { createNodeFs } from "../../NodeFs.ts";
import { sqliteFixture } from "../sqliteFixture.ts";

const pack = NodeBuffer.Buffer.from(
  "UEFDSwAAAAIAAAAEkAx4nKWMQQrDIBAA775i74WyIRtRKKV/yAt2dW0FjSWY4vPbQ37QOc1hmL6rQkjRJrvIPJFGr5gss5BjkYUCTsG7OaA4Mnz0V9thzc+Ni7QBKY9+7Aq3Ux46uL6LXvP24ZLjHTxZ68ghwgV/mNBqzb3rfxdzluYL4vc+zKcEeJwBRwC4/zEwMDY0NCBSRUFETUUubWQAQDkuIZZePq3edELd+Vxtlu+2Nn4xMDA3NTUgcnVuLnNoAES5ayTuDdz1GjrY5rg8TZg9pkRcbMwbPD54nCtKzc0vSVUIcnV08XXlAgAmDQRltwF4nFNW1E/KzNMvzuBKTc7IV0jLrCgpLUrlAgBU4weRjLaGqDQo5R4Is8CADpPQToesV28=",
  "base64",
);
const encoder = new TextEncoder();
const credentials = { uid: 1001, gid: 1002, euid: 1001, egid: 1002 } as const;
const manifest = Object.freeze({
  name: "test-git",
  version: "1.0.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze([]),
  entrypoint: "test-git-v1",
});

export const GIT_FIXTURE_COMMIT = "218b1da7cb6be4a4873f6bca0681b387b4cecab4";

export function gitFixturePack(): Uint8Array {
  return new Uint8Array(pack);
}

export function packWithOversizedDeclaredObject(): Uint8Array {
  const oversized = gitFixturePack();
  oversized[13] = 0x7f;
  return withPackChecksum(oversized.subarray(0, -20));
}

export function packWithOversizedInflatedObject(): Uint8Array {
  const malformed = gitFixturePack();
  const output = new Uint8Array(malformed.byteLength - 1);
  output.set(malformed.subarray(0, 12));
  output[12] = 0x11;
  output.set(malformed.subarray(14), 13);
  return withPackChecksum(output.subarray(0, -20));
}

export function malformedGitPack(): Uint8Array {
  const malformed = gitFixturePack();
  malformed[12] = 0;
  return withPackChecksum(malformed.subarray(0, -20));
}

export function createNodeGitFixture(readOnly = false) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1_800_000_000_000_000_001n);
  storage.posix.initialize(storage.root, {
    mode: 0o755,
    uid: credentials.uid,
    gid: credentials.gid,
  });
  const output: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  const writer = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    stdio: stdio(output),
    posix: { credentials, umask: 0o022 },
  });
  const nodeFs = createNodeFs(writer).fs;
  nodeFs.mkdirSync("/work/nested", { recursive: true });
  nodeFs.mkdirSync("/work/readonly");
  nodeFs.mkdirSync("/home/test", { recursive: true });
  nodeFs.writeFileSync("/README.md", "root decoy\n");
  nodeFs.writeFileSync("/work/README.md", "cwd decoy\n");
  writer.dispose();

  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage, ...(readOnly ? { readOnly: true } : {}) }],
    stdio: stdio(output),
    posix: { credentials, umask: 0o022 },
  });
  return {
    filesystem,
    stdout: () => output.stdout.join(""),
    stderr: () => output.stderr.join(""),
    close() {
      try {
        filesystem.dispose();
      } finally {
        database.close();
      }
    },
  };
}

export function createLocalGitRunner(onRun: () => void = () => undefined): KernelAsyncProgram {
  return {
    async run(_context: KernelAsyncProgramContext) {
      onRun();
      return { exitCode: 0, signal: 0, coreDumped: false };
    },
  };
}

export async function spawnGit(
  filesystem: KernelFileSystem,
  program: KernelAsyncProgram,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  cwd = "/work",
  signal?: AbortSignal,
  beforeSpawn?: (filesystem: KernelFileSystem) => void,
) {
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const registration = registry.register(manifest);
  if (registration.status !== "ok") throw new Error("Test Git program registration failed");
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      ["/usr/bin/git", { manifest, implementation: { kind: "async", run: program.run } }],
    ]),
  });
  const prepared = host.prepare(
    { filesystem, home: "/home/test", ...(signal === undefined ? {} : { signal }) },
    { cwd },
  );
  beforeSpawn?.(prepared.filesystem);
  const resolved = host.resolve("/usr/bin/git");
  if (resolved.status !== "ok") throw new Error("Registered Git program did not resolve");
  const spawned = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args,
    env,
  });
  if (spawned.status !== "ok") throw new Error("Registered Git program failed to start");
  await prepared.release();
  return { host, handle: spawned.value };
}

export async function finishGit(
  host: KernelProgramHost,
  handle: Parameters<KernelProgramHost["exitStatus"]>[0],
) {
  const result = await host.exitStatus(handle);
  if (result.status !== "ok") throw new Error(`Git process failed: ${JSON.stringify(result)}`);
  const reaped = host.reap(handle);
  if (reaped.status !== "ok") throw new Error("Git process was not reaped");
  return result.value;
}

export function createSmartHttpServer(options: {
  readonly authenticate: boolean;
  readonly commit?: string;
  readonly additionalBranches?: readonly string[];
  readonly pack?: Uint8Array;
  readonly fatalSideband?: string;
}) {
  const requests: {
    readonly method: string;
    readonly authorization: string | null;
    readonly url: string;
  }[] = [];
  let rejectedUnauthenticated = false;
  let cancelledUnauthorizedBodies = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ method, authorization, url: `${url.origin}${url.pathname}` });
    if (options.authenticate && authorization === null && !rejectedUnauthenticated) {
      rejectedUnauthenticated = true;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("authentication required"));
          },
          cancel() {
            cancelledUnauthorizedBodies += 1;
          },
        }),
        { status: 401 },
      );
    }
    if (method === "GET" && url.pathname.endsWith("/info/refs")) {
      return new Response(
        responseBuffer(
          advertisement(options.commit ?? GIT_FIXTURE_COMMIT, options.additionalBranches ?? []),
        ),
        { headers: { "content-type": "application/x-git-upload-pack-advertisement" } },
      );
    }
    if (method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
      const body =
        options.fatalSideband === undefined
          ? joinBytes(
              packet("NAK\n"),
              packet(joinBytes(new Uint8Array([1]), options.pack ?? pack)),
              encoder.encode("0000"),
            )
          : joinBytes(
              packet("NAK\n"),
              packet(joinBytes(new Uint8Array([3]), encoder.encode(options.fatalSideband))),
              encoder.encode("0000"),
            );
      return new Response(responseBuffer(body), {
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetch,
    requests,
    get cancelledUnauthorizedBodies() {
      return cancelledUnauthorizedBodies;
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function stdio(output: { stdout: string[]; stderr: string[] }) {
  return [
    { readInto: () => 0 },
    {
      write: (bytes: Uint8Array) => (
        output.stdout.push(new TextDecoder().decode(bytes)),
        bytes.byteLength
      ),
    },
    {
      write: (bytes: Uint8Array) => (
        output.stderr.push(new TextDecoder().decode(bytes)),
        bytes.byteLength
      ),
    },
  ] as const;
}

function advertisement(commit: string, additionalBranches: readonly string[]): Uint8Array {
  return joinBytes(
    packet("# service=git-upload-pack\n"),
    encoder.encode("0000"),
    packet(`${commit} HEAD\0multi_ack ofs-delta side-band-64k symref=HEAD:refs/heads/main\n`),
    packet(`${commit} refs/heads/main\n`),
    ...additionalBranches.map((branch) => packet(`${commit} refs/heads/${branch}\n`)),
    encoder.encode("0000"),
  );
}

function packet(value: string | Uint8Array): Uint8Array {
  const body = typeof value === "string" ? encoder.encode(value) : value;
  return joinBytes(encoder.encode((body.byteLength + 4).toString(16).padStart(4, "0")), body);
}

function joinBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

function withPackChecksum(body: Uint8Array): Uint8Array {
  const output = new Uint8Array(body.byteLength + 20);
  output.set(body);
  output.set(NodeCrypto.createHash("sha1").update(body).digest(), body.byteLength);
  return output;
}
