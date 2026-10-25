import { DurableObject } from "cloudflare:workers";
import {
  CODE_MODE_HOST_EXECUTABLE,
  createCodeModeHostProgram,
  createCodeModeWorkerLoader,
} from "../../../../src/harness/CodeModeHost.ts";
import { ChildWorkerCapacity } from "../../../../src/computer/ChildWorkerCapacity.ts";
import { callKernel, KernelProgramRegistry } from "../../../../src/kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../../../src/kernel/KernelWakeRegistry.ts";
import code from "./cell-code.json" with { type: "json" };
import executable from "./executable.json" with { type: "json" };
import { exchange, frame } from "./exchange.ts";

type Environment = { LOADER: WorkerLoader; PROOF: DurableObjectNamespace<CodeModeProof> };
export class CodeModeProof extends DurableObject<Environment> {
  override async fetch(request: Request) {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS code_mode_diagnostic(id INTEGER PRIMARY KEY, stage TEXT NOT NULL, value TEXT)",
    );
    const mark = (stage: string, value?: unknown) =>
      sql.exec(
        "INSERT INTO code_mode_diagnostic(stage,value) VALUES (?,?)",
        stage,
        JSON.stringify(value ?? null),
      );
    if (new URL(request.url).pathname === "/status")
      return Response.json({
        stages: sql.exec("SELECT * FROM code_mode_diagnostic ORDER BY id").toArray(),
      });
    if (sql.exec("SELECT 1 FROM code_mode_diagnostic LIMIT 1").toArray().length)
      return new Response("One attempt only", { status: 409 });
    mark("fetch-enter");
    const capacity = new ChildWorkerCapacity(2);
    const program = createCodeModeHostProgram({
      loader: createCodeModeWorkerLoader({ loader: this.env.LOADER, policy: { cpuMs: 1000 } }),
      capacity,
      code,
    });
    const registry = new KernelProgramRegistry();
    if (registry.register(program.binding.manifest).status !== "ok")
      throw new Error("Program registration failed");
    const wakes = new KernelWakeRegistry();
    const host = new KernelProgramHost({
      registry,
      wakes,
      programs: new Map([[CODE_MODE_HOST_EXECUTABLE, program.binding]]),
    });
    const storage = createFacetSqliteStorage(this.ctx.storage, () => 1n);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    filesystem.mkdir("/bin", 0o755);
    const marker = Uint8Array.from(executable.bytes);
    const seedFd = filesystem.open(
      CODE_MODE_HOST_EXECUTABLE,
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
      0o755,
    );
    try {
      let offset = 0;
      while (offset < marker.length) {
        const count = filesystem.write(seedFd, marker.subarray(offset), null);
        if (count <= 0) throw new Error("Executable seed made no progress");
        offset += count;
      }
    } finally {
      filesystem.close(seedFd);
    }
    const readFd = filesystem.open(CODE_MODE_HOST_EXECUTABLE, KernelOpenFlags.O_RDONLY);
    try {
      const actual = new Uint8Array(Number(filesystem.fstat(readFd).size));
      let offset = 0;
      while (offset < actual.length) {
        const count = filesystem.read(readFd, actual.subarray(offset), null);
        if (count <= 0) throw new Error("Executable readback made no progress");
        offset += count;
      }
      if (actual.length !== marker.length || !actual.every((byte, index) => byte === marker[index]))
        throw new Error("Executable file seed mismatch");
    } finally {
      filesystem.close(readFd);
    }
    mark("executable-seeded", {
      path: CODE_MODE_HOST_EXECUTABLE,
      sha256: executable.sha256,
      bytes: marker.length,
    });
    const piped = host.preparePiped({ filesystem });
    const writer = piped.stdin.getWriter();
    const reader = piped.stdout.getReader();
    const messages = exchange(reader, mark);
    let inputClosed = false;
    const resolved = host.resolve(CODE_MODE_HOST_EXECUTABLE);
    if (resolved.status !== "ok") throw new Error("Companion resolution failed");
    const spawned = callKernel(host.backend(piped.prepared), "process.spawn", {
      program: resolved.value,
      args: [CODE_MODE_HOST_EXECUTABLE],
      env: {},
    });
    if (spawned.status !== "ok") throw new Error("Companion spawn failed");
    mark("process-spawned", spawned.value);
    let nextId = 0;
    const send = (value: unknown) => writer.write(frame(value));
    const operation = async (request: unknown) => {
      const id = ++nextId;
      await send({ type: "operation/request", id, request });
      const response = await messages.receive(
        (value) => value.type === "operation/response" && value.id === id,
      );
      if ((response.result as { status?: string })?.status !== "ok")
        throw new Error(JSON.stringify(response));
      return id;
    };
    const execute = async (source: string, enabled_tools: unknown[] = []) => {
      const id = await operation({
        method: "session/execute",
        sessionId: "real-workerd-proof",
        request: {
          source,
          tool_call_id: "proof-cell",
          enabled_tools,
          yield_time_ms: 1000,
          max_output_tokens: null,
        },
      });
      const response = await messages.receive(
        (value) => value.type === "execute/initialResponse" && value.id === id,
      );
      const result = response.result as {
        status?: string;
        value?: { Result?: { error_text?: unknown } };
      };
      if (
        result?.status !== "ok" ||
        !result.value?.Result ||
        result.value.Result.error_text !== null
      )
        throw new Error("Cell did not complete successfully: " + JSON.stringify(response));
      return response;
    };
    const expectText = (response: Record<string, unknown>, expected: string[]) => {
      const result = response.result as { value: { Result: { content_items: unknown } } };
      const content = result.value.Result.content_items;
      if (
        JSON.stringify(content) !==
        JSON.stringify(expected.map((text) => ({ type: "input_text", text })))
      )
        throw new Error("Wrong cell output: " + JSON.stringify(response));
    };
    try {
      const hello = frame({
        type: "connection/hello",
        supportedVersions: [1],
        requiredCapabilities: [],
        optionalCapabilities: ["yield-observation"],
      });
      await writer.write(hello.subarray(0, 1));
      await writer.write(hello.subarray(1, 3));
      await writer.write(hello.subarray(3));
      await messages.receive((value) => value.type === "connection/ready");
      await operation({ method: "session/open", sessionId: "real-workerd-proof" });
      const first = await execute(
        'store("name", "saved"); globalThis.cellOnly = true; text("one");',
      );
      expectText(first, ["one"]);
      const second = await execute(
        'text(load("name")); text(typeof cellOnly); text(typeof console); text(typeof WebAssembly);',
      );
      expectText(second, ["saved", "undefined", "undefined", "undefined"]);
      const tools = [
        {
          name: "echo",
          tool_name: { name: "echo", namespace: null },
          description: "Proof echo",
          kind: "function",
          input_schema: null,
          output_schema: null,
        },
      ];
      const thirdPending = execute(
        'text(await tools.echo({value: 42})); await new Promise(resolve => setTimeout(resolve,0)); text("timer");',
        tools,
      );
      const delegated = await Promise.race([
        messages.receive((value) => value.type === "delegate/request"),
        thirdPending.then(() => {
          throw new Error("Cell completed before expected tool request");
        }),
      ]);
      await send({
        type: "delegate/response",
        id: delegated.id,
        result: { status: "ok", value: { type: "tool/result", result: { echoed: 42 } } },
      });
      const third = await thirdPending;
      expectText(third, ['{"echoed":42}', "timer"]);
      await writer.close();
      inputClosed = true;
      const exit = await host.exitStatus(spawned.value);
      if (exit.status !== "ok" || exit.value.exitCode !== 0 || exit.value.signal !== 0)
        throw new Error("Companion failed to exit: " + JSON.stringify(exit));
      await messages.done;
      if (host.reap(spawned.value).status !== "ok")
        throw new Error("Companion could not be reaped");
      await program.drain();
      if (capacity.active !== 0 || host.processes.size !== 0)
        throw new Error("Unreleased process or cell capacity");
      mark("proof-complete");
      return Response.json({
        ok: true,
        first,
        second,
        third,
        delegated,
        exit,
        capacityActive: capacity.active,
        processes: host.processes.size,
        stages: sql.exec("SELECT * FROM code_mode_diagnostic ORDER BY id").toArray(),
      });
    } catch (error) {
      mark("proof-failed", String(error));
      return Response.json(
        {
          ok: false,
          error: String(error),
          stages: sql.exec("SELECT * FROM code_mode_diagnostic ORDER BY id").toArray(),
        },
        { status: 500 },
      );
    } finally {
      if (!inputClosed) await writer.abort().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      writer.releaseLock();
      await host.processes.dispose();
      await program.drain();
      await piped.prepared.release();
      filesystem.dispose();
      wakes.dispose();
    }
  }
}
export default {
  fetch(request: Request, env: Environment) {
    return env.PROOF.getByName("one-attempt").fetch(request);
  },
};
