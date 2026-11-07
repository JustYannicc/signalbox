import { DurableObject } from "cloudflare:workers";
import { createProductComputer } from "../ProductComputer.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createCompiledChildWorkerLoader } from "../CompiledChildWorkerLoader.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import { CODE_MODE_HOST_EXECUTABLE } from "../CodeModeManifest.ts";
import { machineInventoryFixture, emptyMachineFilesFixture } from "../machineInventoryTesting.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createKernelSessionStdio } from "../../kernel/KernelSessionStdio.ts";
import type { CodeModeCellCode } from "../../codeMode/Types.ts";

interface Env {
  LOADER: WorkerLoader;
  HOST: DurableObjectNamespace<Host>;
  CODE: CodeModeCellCode;
}
export class Host extends DurableObject<Env> {
  async run() {
    const wakes = new KernelWakeRegistry();
    const owner = new AbortController();
    const stdio = createKernelSessionStdio(wakes, owner.signal);
    const storage = createFacetSqliteStorage(this.ctx.storage, () => 1n);
    storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
    const files = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
      stdio: stdio.stdio,
    });
    files.mkdir("/work");
    files.chdir("/work");
    const capacity = new ChildWorkerCapacity(10, {
      owner: "test/native-cell-drain",
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
    });
    const unused = {
      mainModule: "unused.js",
      modules: { "unused.js": { js: "export default {};" } },
    };
    const coreutils = Object.fromEntries(
      CHILD_COREUTILS_COMMANDS.map((name) => [name, unused]),
    ) as Record<(typeof CHILD_COREUTILS_COMMANDS)[number], typeof unused>;
    const computer = createProductComputer({
      threadId: "native-cell-drain",
      filesystem: files,
      wakes,
      signal: owner.signal,
      capacity,
      loader: createCompiledChildWorkerLoader(this.env.LOADER, new Map()),
      programs: {
        bash: unused,
        busyboxCat: unused,
        busyboxApplets: unused,
        productBusyboxApplets: unused,
        ripgrep: unused,
        git: unused,
        sed: unused,
        jq: unused,
        ugrep: unused,
        coreutils,
        codeMode: this.env.CODE,
      },
      machineInventory: machineInventoryFixture(),
      machine: () => ({
        files: emptyMachineFilesFixture(),
        async spawn() {
          throw new Error("Unexpected machine");
        },
      }),
    });
    const child = await computer.exec(
      {
        executable: CODE_MODE_HOST_EXECUTABLE,
        argv: [CODE_MODE_HOST_EXECUTABLE],
        cwd: "/work",
        env: {},
      },
      owner.signal,
      undefined,
    );
    const writer = child.stdin.getWriter();
    const armed = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const output = (async () => {
      const reader = child.stdout.getReader();
      let bytes = new Uint8Array();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const next = new Uint8Array(bytes.length + chunk.value.length);
        next.set(bytes);
        next.set(chunk.value, bytes.length);
        bytes = next;
        while (bytes.length >= 4) {
          const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
          if (bytes.length < length + 4) break;
          const text = new TextDecoder().decode(bytes.subarray(4, length + 4));
          bytes = bytes.slice(length + 4);
          const message = JSON.parse(text);
          if (message.type === "connection/ready") ready.resolve();
          if (message.type === "operation/response" && message.id === 1) opened.resolve();
          if (message.type === "execute/initialResponse" && text.includes("armed")) armed.resolve();
        }
      }
    })().catch(ignoreCancelled);
    const errors = new Response(child.stderr).text().catch((error) => {
      ignoreCancelled(error);
      return "";
    });
    const send = (value: unknown) => {
      const payload = new TextEncoder().encode(JSON.stringify(value));
      const bytes = new Uint8Array(payload.length + 4);
      new DataView(bytes.buffer).setUint32(0, payload.length, true);
      bytes.set(payload, 4);
      return writer.write(bytes);
    };
    try {
      await send({
        type: "connection/hello",
        supportedVersions: [1],
        requiredCapabilities: [],
        optionalCapabilities: [],
      });
      await ready.promise;
      await send({
        type: "operation/request",
        id: 1,
        request: { method: "session/open", sessionId: "native" },
      });
      await opened.promise;
      await send({
        type: "operation/request",
        id: 2,
        request: {
          method: "session/execute",
          sessionId: "native",
          request: {
            tool_call_id: "timer",
            source: 'text("armed"); yield_control(); await new Promise(r => setTimeout(r, 60000));',
            enabled_tools: [],
            yield_time_ms: 10000,
            max_output_tokens: null,
          },
        },
      });
      await armed.promise;
      await child.signal(15);
      await computer.drain();
      const exit = await child.exited;
      await computer.close();
      return {
        exit,
        active: capacity.active,
        processes: computer.processes.size,
        stderr: await errors,
      };
    } finally {
      await computer.close();
      await child.dispose();
      writer.releaseLock();
      await output;
      await stdio.dispose();
      files.dispose();
      wakes.dispose();
    }
  }
}
export default {
  async fetch(_request: Request, env: Env) {
    try {
      return Response.json(await env.HOST.getByName("test").run());
    } catch (error) {
      return Response.json(
        { error: String(error), stack: error instanceof Error ? error.stack : undefined },
        { status: 500 },
      );
    }
  },
};

function ignoreCancelled(error: unknown) {
  if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ECANCELED")
    throw error;
}
