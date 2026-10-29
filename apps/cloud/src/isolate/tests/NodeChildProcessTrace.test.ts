import { describe, expect, it } from "@effect/vitest";

import { kernelError, ABI_VERSION, KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import {
  KernelProgramHost,
  type KernelInlineProgram,
  type KernelProgramBinding,
} from "../../kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import {
  createNodeChildProcess,
  type NodeChildProcess,
  type NodeChildProcessContext,
  type NodeChildProcessTransport,
} from "../NodeChildProcess.ts";
import {
  createNodeChildProcessTrace,
  type NodeChildProcessTraceEvent,
  type NodeChildProcessTraceOutputMetadata,
  type NodeChildProcessTraceOptions,
} from "../NodeChildProcessTrace.ts";
import { createNodeFs } from "../NodeFs.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

function harness(
  runInline: KernelInlineProgram,
  overrides: {
    readonly transport?: NodeChildProcessTransport;
    readonly beforeStart?: (child: NodeChildProcess) => void;
    readonly writeOutputChunk?: NodeChildProcessTraceOptions["writeOutputChunk"];
    readonly finishOutput?: NodeChildProcessTraceOptions["finishOutput"];
    readonly record?: NodeChildProcessTraceOptions["record"];
  } = {},
) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
  });
  filesystem.mkdir("/work");
  filesystem.chdir("/work");

  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "trace-tool",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.spawn"] as const,
    entrypoint: "trace-tool",
  };
  if (registry.register(manifest).status !== "ok") throw new Error("Program registration failed");
  const binding: KernelProgramBinding = {
    manifest,
    implementation: { kind: "javascript", runInline },
  };
  const processes = new KernelProcessTable({ wakes });
  const programHost = new KernelProgramHost({
    registry,
    wakes,
    processes,
    programs: new Map([["/bin/trace-tool", binding]]),
  });
  const context: NodeChildProcessContext = {
    filesystem,
    env: { PATH: "/bin", HOME: "/work/home" },
    home: "/work/home",
  };
  const events: NodeChildProcessTraceEvent[] = [];
  const chunks = new Map<string, Uint8Array[]>();
  const outputs: NodeChildProcessTraceOutputMetadata[] = [];
  const trace = createNodeChildProcessTrace({
    processKey: "host-process-key",
    files: () => filesystem,
    record: (event) => {
      events.push(event);
      return overrides.record?.(event);
    },
    writeOutputChunk:
      overrides.writeOutputChunk ??
      ((outputId, bytes) => {
        const saved = chunks.get(outputId) ?? [];
        saved.push(bytes.slice());
        chunks.set(outputId, saved);
      }),
    finishOutput:
      overrides.finishOutput ??
      ((metadata) => {
        outputs.push(metadata);
        return `sqlite:replay_product_event:a29-child-output-chunk:${metadata.outputId}`;
      }),
  });
  const observer = (child: NodeChildProcess, spawn: Parameters<typeof trace.onChildProcess>[1]) => {
    trace.onChildProcess(child, spawn);
    overrides.beforeStart?.(child);
  };
  const childProcess = createNodeChildProcess(programHost, context, overrides.transport, observer);
  const nodeFs = createNodeFs(filesystem).fs;

  return {
    childProcess,
    chunks,
    events,
    filesystem,
    nodeFs,
    outputs,
    trace,
    async close() {
      await processes.dispose();
      filesystem.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

function closed(child: NodeChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function eventsOfKind<K extends NodeChildProcessTraceEvent["eventKind"]>(
  events: readonly NodeChildProcessTraceEvent[],
  eventKind: K,
): Extract<NodeChildProcessTraceEvent, { eventKind: K }>[] {
  return events.filter(
    (event): event is Extract<NodeChildProcessTraceEvent, { eventKind: K }> =>
      event.eventKind === eventKind,
  );
}

function joinedChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("passive Node child process trace", () => {
  it("pins and captures one combined binary output after the parent closes and unlinks it", async () => {
    const stdoutBytes = new Uint8Array([0, 255, 10]);
    const stderrBytes = new Uint8Array([128, 13]);
    const host = harness(({ filesystem }) => {
      filesystem.write(1, stdoutBytes, null);
      filesystem.write(2, stderrBytes, null);
      return 0;
    });
    const path = "/work/child-output.bin";
    const fd = host.nodeFs.openSync(path, "w+");
    const parentFds = [...host.filesystem.descriptors.entries()].map(([number]) => number);
    try {
      const child = host.childProcess.spawn("/bin/trace-tool", {
        stdio: ["ignore", fd, fd],
      });
      const closeAndUnlink = new Promise<void>((resolve) => {
        child.once("close", () => {
          host.nodeFs.closeSync(fd);
          host.filesystem.unlink(path);
          resolve();
        });
      });
      expect([...host.filesystem.descriptors.entries()].map(([number]) => number)).toEqual(
        parentFds,
      );
      await closeAndUnlink;
      await host.trace.drain();

      expect(host.outputs).toHaveLength(1);
      expect(host.outputs[0]).toMatchObject({
        streams: ["stdout", "stderr"],
        streamLabel: "combined",
        originalSize: "5",
        bytesCaptured: 5,
        fullHash: true,
        stable: true,
      });
      const outputId = host.outputs[0]!.outputId;
      expect([...joinedChunks(host.chunks.get(outputId) ?? [])]).toEqual([0, 255, 10, 128, 13]);

      const request = eventsOfKind(host.events, "spawn-request")[0]!;
      const spawned = eventsOfKind(host.events, "spawn")[0]!;
      const close = eventsOfKind(host.events, "close")[0]!;
      const output = eventsOfKind(host.events, "output").find(
        (event) => event.status === "captured",
      );
      expect(request).toMatchObject({
        processKey: "host-process-key",
        childId: spawned.childId,
        normalizedSpawn: { argv: ["/bin/trace-tool"], cwd: "/work", stdio: ["ignore", fd, fd] },
      });
      expect(spawned.handle.present).toBe(true);
      expect(spawned.pid.present).toBe(true);
      expect(close.args[1]!.kind).toBe("null");
      expect(close.processHandleAtClose.present).toBe(false);
      expect(output).toMatchObject({
        streamLabel: "combined",
        locator: `sqlite:replay_product_event:a29-child-output-chunk:${outputId}`,
      });
      expect(eventsOfKind(host.events, "terminal-summary")[0]!.events).toMatchObject({
        errorEvents: 0,
        errorEventObserved: false,
      });
    } finally {
      if (host.filesystem.descriptors.has(fd)) host.nodeFs.closeSync(fd);
      await host.close();
    }
  });

  it("records Error fields and actual errorMonitor argument presence without adding an error listener", async () => {
    let countBeforeTrace = -1;
    const host = harness(() => 0, {
      beforeStart: (child) => {
        countBeforeTrace = child.listenerCount("error");
      },
    });
    try {
      const child = host.childProcess.spawn("/bin/trace-tool");
      expect(countBeforeTrace).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      let ordinaryErrors = 0;
      child.on("error", () => (ordinaryErrors += 1));
      const ordinaryCount = child.listenerCount("error");
      const cause: { nested: unknown[]; self?: unknown } = { nested: [1n] };
      cause.self = cause;
      const error = Object.assign(new Error("spawn failed"), {
        code: "EIO",
        errno: -5,
        syscall: "spawn",
        path: "/bin/trace-tool",
        spawnargs: ["/bin/trace-tool"],
        cause,
      });
      child.emit("error", error, null);
      child.emit("error", error, undefined);
      child.emit("error", error);
      expect(child.listenerCount("error")).toBe(ordinaryCount);
      expect(ordinaryErrors).toBe(3);
      await closed(child);
      await host.trace.drain();

      const errors = eventsOfKind(host.events, "error");
      expect(errors).toHaveLength(3);
      expect(errors.map((event) => event.args.length)).toEqual([2, 2, 1]);
      expect(errors[0]!.args[1]!.kind).toBe("null");
      expect(errors[1]!.args[1]!.kind).toBe("undefined");
      const serialized = errors[0]!.args[0] as {
        readonly kind: string;
        readonly fields: Readonly<Record<string, { readonly value?: { readonly kind?: string } }>>;
      };
      expect(serialized.kind).toBe("error");
      expect(serialized.fields.code!.value).toMatchObject({ kind: "string", value: "EIO" });
      expect(serialized.fields.errno!.value).toMatchObject({ kind: "number", value: -5 });
      const causeValue = serialized.fields.cause!.value as {
        readonly kind: string;
        readonly properties: Readonly<
          Record<
            string,
            {
              readonly kind?: string;
              readonly items?: readonly { readonly kind?: string; readonly value?: string }[];
            }
          >
        >;
      };
      expect(causeValue.kind).toBe("object");
      expect(causeValue.properties.nested).toMatchObject({
        kind: "array",
        items: [{ kind: "bigint", value: "1" }],
      });
      expect(causeValue.properties.self!.kind).toBe("reference");
      expect(eventsOfKind(host.events, "close")[0]!.args[1]!.kind).toBe("null");
    } finally {
      await host.close();
    }
  });

  it("leaves piped output untouched and records an explicit passive-capture gap", async () => {
    const stdoutBytes = new Uint8Array([0, 255, 4]);
    const stderrBytes = new Uint8Array([8, 10]);
    const host = harness(({ filesystem }) => {
      filesystem.write(1, stdoutBytes, null);
      filesystem.write(2, stderrBytes, null);
      return 0;
    });
    try {
      const child = host.childProcess.spawn("/bin/trace-tool");
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) throw new Error("Expected public child output pipes");
      const read = (stream: NonNullable<NodeChildProcess["stdout"]>) =>
        new Promise<Uint8Array>((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          stream.on("data", (chunk: Uint8Array) => chunks.push(chunk.slice()));
          stream.once("end", () => resolve(joinedChunks(chunks)));
          stream.once("error", reject);
        });
      const stdoutOutput = read(stdout);
      const stderrOutput = read(stderr);
      await closed(child);
      await host.trace.drain();

      expect([...(await stdoutOutput)]).toEqual([...stdoutBytes]);
      expect([...(await stderrOutput)]).toEqual([...stderrBytes]);
      expect(host.chunks.size).toBe(0);
      expect(eventsOfKind(host.events, "output")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stream: "stdout",
            status: "gap",
            reason: "pipe-output-not-consumed",
          }),
          expect.objectContaining({
            stream: "stderr",
            status: "gap",
            reason: "pipe-output-not-consumed",
          }),
        ]),
      );
    } finally {
      await host.close();
    }
  });

  it("observes lifecycle events before pending durable writes can reorder hook windows", async () => {
    const write = Promise.withResolvers<void>();
    const host = harness(() => 0, { record: () => write.promise });
    try {
      const child = host.childProcess.spawn("/bin/trace-tool", { stdio: "ignore" });
      await closed(child);
      expect(eventsOfKind(host.events, "spawn")).toHaveLength(1);
      expect(eventsOfKind(host.events, "close")).toHaveLength(1);
    } finally {
      write.resolve();
      await host.trace.drain();
      await host.close();
    }
  });

  it.each(["chunk", "locator"])(
    "stores output writer failures in the drained snapshot: %s",
    async (failure) => {
      const host = harness(
        ({ filesystem }) => {
          filesystem.write(1, new Uint8Array([1, 2, 3]), null);
          return 0;
        },
        failure === "chunk"
          ? {
              writeOutputChunk: () => {
                throw Object.assign(new Error("journal full"), { code: "ENOSPC" });
              },
            }
          : { finishOutput: () => "" },
      );
      const path = "/work/failing-output.bin";
      const fd = host.nodeFs.openSync(path, "w+");
      try {
        const child = host.childProcess.spawn("/bin/trace-tool", {
          stdio: ["ignore", fd, "ignore"],
        });
        await closed(child);
        await host.trace.drain();

        expect(host.trace.snapshot().writerErrors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              operation: failure === "chunk" ? "write-output-chunk" : "finish-output",
              outputId: expect.any(String),
            }),
          ]),
        );
        expect(host.outputs).toHaveLength(0);
        expect(eventsOfKind(host.events, "output")).toContainEqual(
          expect.objectContaining({ status: "gap", reason: "capture-failed" }),
        );
      } finally {
        if (host.filesystem.descriptors.has(fd)) host.nodeFs.closeSync(fd);
        await host.close();
      }
    },
  );

  it("does not mistake an existing file for child output when admission fails", async () => {
    const host = harness(() => 0, {
      transport: { spawn: () => kernelError("NOT_FOUND", "admission refused") },
    });
    const path = "/work/pre-existing.bin";
    host.nodeFs.writeFileSync(path, new Uint8Array([9, 8, 7]));
    const fd = host.nodeFs.openSync(path, "r+");
    try {
      const child = host.childProcess.spawn("/bin/trace-tool", {
        stdio: ["ignore", fd, "ignore"],
      });
      const childClosed = closed(child);
      child.on("error", () => undefined);
      await childClosed;
      await host.trace.drain();

      const request = eventsOfKind(host.events, "spawn-request")[0]!;
      const summary = eventsOfKind(host.events, "terminal-summary")[0]!;
      expect(request.admission.pid.present).toBe(false);
      expect(request.admission.handle.present).toBe(false);
      expect(eventsOfKind(host.events, "spawn")).toHaveLength(0);
      expect(summary.status.processHandle).toMatchObject({ present: false });
      expect(host.outputs).toHaveLength(0);
      expect(eventsOfKind(host.events, "output")).toContainEqual(
        expect.objectContaining({ status: "gap", reason: "child-never-emitted-spawn" }),
      );
    } finally {
      if (host.filesystem.descriptors.has(fd)) host.nodeFs.closeSync(fd);
      await host.close();
    }
  });
});
