import { fileSearchProof } from "./cancellation.ts";
import ENGINE from "./codex-engine.wasm";
import { retentionClock } from "./retentionClock.ts";
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
import {
  startCodexHarnessProcess,
  type CodexHarnessProcessOptions,
} from "../../CodexHarnessProcess.ts";
import { CODE_MODE_HOST_EXECUTABLE } from "../../CodeModeHost.ts";
import type { KernelCommand } from "../../../kernel/KernelCommandForwarder.ts";
import { appServerDriver } from "./driver.ts";
import { codeModeResponses } from "./model.ts";
import { authenticatedGateway } from "./authenticated.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import { freshThread } from "./fresh.ts";
import type { CodeModeLifecycleEvent } from "../../../codeMode/Lifecycle.ts";

interface Env {
  readonly LOADER: WorkerLoader;
  readonly HOST: DurableObjectNamespace<Host>;
  readonly SOURCES: FullChildProgramSources;
  readonly SEED: readonly SeedFile[];
  readonly ASSETS: Readonly<Record<string, string>>;
}

export class Host extends DurableObject<Env> {
  async run(
    provider?:
      | "search"
      | "default"
      | "openai"
      | "dotted"
      | "flat"
      | "auth-default"
      | "auth-openai"
      | "reconnect",
    disconnectExec = false,
  ) {
    const fresh = provider !== undefined && provider !== "search";
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
    const modelHttpRequests: { method: string; url: string; upgrade: string | null }[] = [];
    const nativeSpawns: { executable: string; parent: unknown }[] = [];
    const originalSpawn = computer.host.spawn.bind(computer.host);
    computer.host.spawn = (context, request) => {
      nativeSpawns.push({ executable: request.execPath, parent: context.parent });
      return originalSpawn(context, request);
    };
    const execCalls: KernelCommand[] = [];
    const execWire: unknown[] = [];
    let detach: (() => void) | undefined;
    let outage = false;
    const initializationErrors: unknown[] = [];
    let initialSessionId: string | undefined;
    let retainedUntil: number | undefined;
    let admission:
      | {
          sessionId: string;
          previousSessionId: string;
          admittedAt: number;
          retainedUntil: number | undefined;
        }
      | undefined;
    const connect = CodexExecSessions.prototype.connect;
    CodexExecSessions.prototype.connect = function (send, disconnect, owner) {
      let initializeId: unknown;
      const connection = connect.call(
        this,
        (message) => {
          if (
            provider === "reconnect" &&
            (("id" in message && message.id === 1) || "error" in message)
          )
            execWire.push({ direction: "out", message });
          if (provider === "reconnect" && "id" in message && message.id === initializeId) {
            if ("error" in message) {
              initializationErrors.push(message.error);
              // Let a broken implementation finish so the assertion reports the rejected admission.
              retentionClock.advance(retentionClock.ttlMs);
            } else if (
              "result" in message &&
              typeof message.result === "object" &&
              message.result !== null &&
              "sessionId" in message.result &&
              typeof message.result.sessionId === "string"
            ) {
              if (initialSessionId === undefined) initialSessionId = message.result.sessionId;
              else
                admission = {
                  sessionId: message.result.sessionId,
                  previousSessionId: initialSessionId,
                  admittedAt: retentionClock.now,
                  retainedUntil,
                };
            }
          }
          if ("method" in message && message.method.startsWith("process/"))
            execWire.push({ direction: "out", message });
          return send(message);
        },
        disconnect,
        owner,
      );
      detach ??= () => {
        if (!disconnectExec) return;
        outage = true;
        connection.disconnect(1011, "Fixture host transport outage");
      };
      return {
        get closed() {
          return connection.closed;
        },
        disconnect: connection.disconnect,
        receive(text) {
          const message = JSON.parse(text);
          if (provider === "reconnect") {
            if (message.method === "initialize") {
              initializeId = message.id;
              execWire.push({ direction: "in", message });
              if (outage && !message.params?.resumeSessionId) {
                retainedUntil = retentionClock.nextDeadline;
                retentionClock.advance(1);
              }
            }
            // Keep recovery offline until Codex gives up; its next fresh connection can reach the host.
            if (outage && message.method === "initialize" && message.params?.resumeSessionId) {
              connection.disconnect(1011, "Fixture host transport outage");
              return Promise.resolve();
            }
          }
          if (typeof message.method === "string" && message.method.startsWith("process/"))
            execWire.push({ direction: "in", message });
          return connection.receive(text);
        },
      };
    };
    const resultObservations: {
      tool_call_id: string;
      lifecycle: CodeModeLifecycleEvent[];
    }[] = [];
    const model = codeModeResponses((body) => {
      if (!Array.isArray(body.input)) return;
      const input: readonly unknown[] = body.input;
      for (const item of input) {
        if (
          typeof item !== "object" ||
          item === null ||
          !("type" in item) ||
          !("call_id" in item) ||
          item.type !== "custom_tool_call_output" ||
          typeof item.call_id !== "string" ||
          resultObservations.some((result) => result.tool_call_id === item.call_id)
        )
          continue;
        // Snapshot at the engine's first delivery of this result, before any teardown.
        resultObservations.push({
          tool_call_id: item.call_id,
          lifecycle: lifecycle.filter((event) => event.tool_call_id === item.call_id),
        });
      }
    }, provider !== "reconnect");
    const auth =
      provider === "auth-default" || provider === "auth-openai"
        ? await authenticatedGateway()
        : undefined;
    if (auth !== undefined) {
      const fs = createNodeFs(files).fs;
      fs.mkdirSync("/home/codex/.codex", { recursive: true });
      fs.writeFileSync(
        "/home/codex/.codex/auth.json",
        JSON.stringify({ OPENAI_API_KEY: auth.token }),
      );
    }
    let driver: ReturnType<typeof appServerDriver> | undefined;
    let result: unknown;
    try {
      const processOptions = {
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
          ...(auth === undefined ? { OPENAI_API_KEY: "fixture-only" } : {}),
        },
        bootstrap: {
          type: "bootstrap",
          host_capabilities: { standard_form_input: true },
          codex_home: "/home/codex/.codex",
          cwd: "/work",
          overrides: {
            check_for_update_on_startup: false,
            "analytics.enabled": false,
            "feedback.enabled": false,
            model: "gpt-5.5",
            cli_auth_credentials_store: "file",
            ...(provider === "default" || provider === "auth-default"
              ? {}
              : provider === "openai" || provider === "auth-openai"
                ? { model_provider: "openai" }
                : {
                    model_provider: provider === "dotted" ? "fixture.dot" : "fixture",
                    model_providers: {
                      [provider === "dotted" ? "fixture.dot" : "fixture"]: {
                        name: "Fixture",
                        base_url: "http://model.fixture/v1",
                        wire_api: "responses",
                        requires_openai_auth: false,
                        supports_websockets: fresh,
                        request_max_retries: 0,
                        stream_max_retries: 0,
                      },
                    },
                  }),
            ...(provider === "flat" ? { "model_providers.fixture.supports_websockets": true } : {}),
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
        fetch: (request) => {
          if (new URL(request.url).origin !== "http://model.fixture")
            return Promise.resolve(new Response(null, { status: 404 }));
          modelHttpRequests.push({
            method: request.method,
            url: request.url,
            upgrade: request.headers.get("upgrade"),
          });
          if (request.headers.has("upgrade"))
            return Promise.resolve(new Response(null, { status: 426 }));
          return auth === undefined ? model.fetch(request) : auth.fetch(request);
        },
        lifetime: this.ctx,
        signal: controller.signal,
      } satisfies CodexHarnessProcessOptions;
      if (fresh) {
        result = {
          ...(await freshThread(
            processOptions,
            provider === "reconnect" ? "reconnect-test" : auth?.secret,
            provider === "reconnect" ? { beforeFirstTurn: () => detach?.() } : undefined,
          )),
          ...(provider === "reconnect" ? { execWire, initializationErrors, admission } : {}),
          authentication:
            auth === undefined
              ? null
              : {
                  requests: auth.requests,
                  arrivals: auth.arrivals,
                  secret: auth.secret,
                  placeholder: auth.placeholder,
                },
          modelRequests: model.requests,
          modelHttpRequests,
        };
      } else {
        const process = await startCodexHarnessProcess(processOptions);
        driver = appServerDriver(process);
        await process.ready;
        if (provider === "search") {
          result = {
            ...(await fileSearchProof(files, storage, driver)),
            modelRequests: model.requests,
          };
        } else {
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
            resultObservations,
            execWire,
            modelRequests: model.requests,
            frames: driver.frames,
            stderr: driver.errors.join(""),
            directory: files.stat("/work/docs/routines/evening").type,
            companionManifest: computer.host.resolve(CODE_MODE_HOST_EXECUTABLE),
          };
        }
      }
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
  async fetch(request: Request, env: Env) {
    try {
      return Response.json(
        await env.HOST.getByName(new URL(request.url).pathname).run(
          new URL(request.url).pathname === "/search"
            ? "search"
            : ["/reconnect", "/reconnect-control"].includes(new URL(request.url).pathname)
              ? "reconnect"
              : new URL(request.url).pathname === "/fresh-default" ||
                  new URL(request.url).pathname === "/fresh"
                ? "default"
                : new URL(request.url).pathname === "/fresh-openai"
                  ? "openai"
                  : new URL(request.url).pathname === "/fresh-dotted"
                    ? "dotted"
                    : new URL(request.url).pathname === "/fresh-flat"
                      ? "flat"
                      : new URL(request.url).pathname === "/auth-default"
                        ? "auth-default"
                        : new URL(request.url).pathname === "/auth-openai"
                          ? "auth-openai"
                          : undefined,
          new URL(request.url).pathname === "/reconnect",
        ),
      );
    } catch (error) {
      return Response.json(
        { error: String(error), stack: error instanceof Error ? error.stack : undefined },
        { status: 500 },
      );
    }
  },
};
