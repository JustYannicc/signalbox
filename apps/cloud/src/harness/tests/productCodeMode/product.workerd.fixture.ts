import ENGINE from "./codex-engine.wasm";
import { CodexExecSessions } from "../../../kernel/CodexExecSessions.ts";
import { DurableObject } from "cloudflare:workers";
import { createProductComputer } from "../../../computer/ProductComputer.ts";
import { createAssetChildWorkerLoader } from "../../../computer/CompiledChildWorkerLoader.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { createFacetSqliteStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../../kernel/KernelWakeRegistry.ts";
import { createKernelSessionStdio } from "../../../kernel/KernelSessionStdio.ts";
import { writeSeedFiles } from "../../../kernel/KernelSeedCatalog.ts";
import type { SeedFile } from "../../../kernel/KernelSeedCatalog.ts";
import { createSeededCommandProgramCodes } from "../../../../infra/childPrograms/programCodes.ts";
import type { FullChildProgramSources } from "../../../../infra/childPrograms/prepare.ts";
import {
  emptyMachineFilesFixture,
  machineInventoryFixture,
} from "../../../computer/machineInventoryTesting.ts";
import { startCodexHarnessProcess } from "../../CodexHarnessProcess.ts";
import { CODE_MODE_HOST_EXECUTABLE } from "../../CodeModeHost.ts";
import type { KernelCommand } from "../../../kernel/KernelCommandForwarder.ts";
import { appServerDriver } from "./driver.ts";
import { codeModeResponses } from "./model.ts";
import type { CodeModeLifecycleEvent } from "../../../codeMode/Lifecycle.ts";

interface Env {
  readonly LOADER: WorkerLoader;
  readonly HOST: DurableObjectNamespace<Host>;
  readonly SOURCES: FullChildProgramSources;
  readonly SEED: readonly SeedFile[];
  readonly ASSETS: Readonly<Record<string, string>>;
}

export class Host extends DurableObject<Env> {
  async run() {
    const wakes = new KernelWakeRegistry();
    const controller = new AbortController();
    const stdio = createKernelSessionStdio(wakes, controller.signal);
    const storage = createFacetSqliteStorage(this.ctx.storage, () => 1n);
    storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
    const files = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
      stdio: stdio.stdio,
    });
    for (const path of ["/work", "/tmp", "/home", "/home/codex"]) files.mkdir(path);
    files.chdir("/work");
    const asset = (hash: string) =>
      Uint8Array.from(atob(this.env.ASSETS[hash]!), (char) => char.charCodeAt(0));
    writeSeedFiles(
      files,
      this.env.SEED,
      new Map(this.env.SEED.map((entry) => [entry.path, asset(entry.sha256)])),
    );
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/product-code-mode",
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
    });
    const machineCalls: string[] = [];
    const cellTools: unknown[] = [];
    const lifecycle: CodeModeLifecycleEvent[] = [];
    const loader = createAssetChildWorkerLoader(
      this.env.LOADER,
      async (hash) => asset(hash).buffer,
    );
    const observedLoader = {
      ...loader,
      cells: {
        run: (
          input: Parameters<NonNullable<typeof loader.cells>["run"]>[0],
          events: Parameters<NonNullable<typeof loader.cells>["run"]>[1],
        ) => {
          cellTools.push(input.request.enabled_tools.map((tool) => tool.name));
          return loader.cells!.run(input, events);
        },
      },
    };
    const computer = createProductComputer({
      threadId: "product-code-mode",
      filesystem: files,
      wakes,
      signal: controller.signal,
      capacity,
      loader: observedLoader,
      onCodeModeLifecycle: (event) => lifecycle.push(event),
      programs: createSeededCommandProgramCodes(this.env.SOURCES),
      machineInventory: machineInventoryFixture(),
      machine: () => ({
        files: emptyMachineFilesFixture(),
        async spawn(command) {
          machineCalls.push(command.executable);
          throw new Error("CodeMode must remain in the product Computer");
        },
      }),
    });
    const nativeSpawns: { executable: string; parent: unknown }[] = [];
    const originalSpawn = computer.host.spawn.bind(computer.host);
    computer.host.spawn = (context, request) => {
      nativeSpawns.push({ executable: request.execPath, parent: context.parent });
      return originalSpawn(context, request);
    };
    const execCalls: KernelCommand[] = [];
    const execWire: unknown[] = [];
    const connect = CodexExecSessions.prototype.connect;
    CodexExecSessions.prototype.connect = function (send, disconnect) {
      const connection = connect.call(
        this,
        (message) => {
          if ("method" in message && message.method.startsWith("process/"))
            execWire.push({ direction: "out", message });
          return send(message);
        },
        disconnect,
      );
      return {
        get closed() {
          return connection.closed;
        },
        disconnect: connection.disconnect,
        receive(text) {
          const message = JSON.parse(text);
          if (typeof message.method === "string" && message.method.startsWith("process/"))
            execWire.push({ direction: "in", message });
          return connection.receive(text);
        },
      };
    };
    const model = codeModeResponses();
    let driver: ReturnType<typeof appServerDriver> | undefined;
    let result: unknown;
    try {
      const process = await startCodexHarnessProcess({
        engine: ENGINE,
        host: computer.host,
        stdio,
        computer: {
          files,
          threadId: "product-code-mode",
          exec: (command, signal, requester) => {
            execCalls.push(command);
            return computer.exec(command, signal, requester);
          },
          port: async () => {
            throw new Error("Unexpected Computer port");
          },
          save: async () => {
            throw new Error("Unexpected Computer save");
          },
        },
        environment: {
          HOME: "/home/codex",
          PWD: "/work",
          PATH: "/bin:/usr/bin",
          SHELL: "/bin/bash",
          CODEX_EXEC_SERVER_URL: "ws://localhost/exec",
          OPENAI_API_KEY: "fixture-only",
        },
        bootstrap: {
          type: "bootstrap",
          codex_home: "/home/codex/.codex",
          cwd: "/work",
          overrides: {
            check_for_update_on_startup: false,
            "analytics.enabled": false,
            "feedback.enabled": false,
            model: "gpt-5.5",
            model_provider: "fixture",
            "model_providers.fixture": {
              name: "Fixture",
              base_url: "http://model.fixture/v1",
              wire_api: "responses",
              requires_openai_auth: false,
              supports_websockets: false,
              request_max_retries: 0,
              stream_max_retries: 0,
            },
            "features.respect_system_proxy": true,
            "features.shell_snapshot": false,
            "features.unified_exec": true,
            "features.code_mode": true,
          },
        },
        environmentInfo: {
          cwd: "file:///work",
          userHomeDir: "file:///home/codex",
          tempDir: "file:///tmp",
          capabilities: { tty: false },
          platformOs: "linux",
          shell: { name: "bash", path: "/bin/bash" },
          executorVersion: "product-code-mode-fixture",
        },
        fetch: (request) => model.fetch(request),
        lifetime: this.ctx,
        signal: controller.signal,
      });
      driver = appServerDriver(process);
      await process.ready;
      const started = await driver.request("thread/start", {
        cwd: "/work",
        model: "gpt-5.5",
        modelProvider: "fixture",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      const threadId = started.thread?.id;
      if (threadId === undefined) throw new Error("Official engine did not start a thread");
      await driver.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Create docs/routines/evening through exec." }],
        cwd: "/work",
        model: "gpt-5.5",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      const completed = await driver.completed;
      result = {
        completed,
        nativeSpawns,
        execCalls,
        machineCalls,
        cellTools,
        lifecycle,
        execWire,
        modelRequests: model.requests,
        frames: driver.frames,
        stderr: driver.errors.join(""),
        directory: files.stat("/work/docs/routines/evening").type,
        companionManifest: computer.host.resolve(CODE_MODE_HOST_EXECUTABLE),
      };
    } catch (error) {
      throw new Error(
        `Product CodeMode failed: ${String(error)} ${JSON.stringify({ frames: driver?.frames, stderr: driver?.errors, modelRequests: model.requests, nativeSpawns, execCalls, cellTools, execWire })}`,
        { cause: error },
      );
    } finally {
      await driver?.close();
      CodexExecSessions.prototype.connect = connect;
      await computer.close();
      await stdio.dispose();
      files.dispose();
      wakes.dispose();
    }
    return { result, active: capacity.active, processes: computer.processes.size };
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    try {
      return Response.json(await env.HOST.getByName("proof").run());
    } catch (error) {
      return Response.json(
        { error: String(error), stack: error instanceof Error ? error.stack : undefined },
        { status: 500 },
      );
    }
  },
};
