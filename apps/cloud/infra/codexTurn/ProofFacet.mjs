import { DurableObject } from "cloudflare:workers";
import { AgentOsDescriptorHost } from "../../src/kernel/AgentOsDescriptorHost.ts";
import { AgentOsFileSystemHost } from "../../src/kernel/AgentOsFileSystemHost.ts";
import { AgentOsProcessHost } from "../../src/kernel/AgentOsProcessHost.ts";
import { createFacetSqliteStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { kernelError, KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelPipe } from "../../src/kernel/KernelPipe.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { readProofModelCpu } from "./ProofModelCpu.mjs";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createKernelAsyncWasi } from "../../src/kernel/KernelWasi.ts";
import { createAppServerDriver, proofModel } from "./AppServerDriver.mjs";
import { createMockHttpAdapter } from "./MockHttpAdapter.mjs";
import { createMockResponses } from "./MockResponses.mjs";
import { createLocalProofModel } from "./ProofModelTransport.mjs";
import { createProofExec, createProofWebSocket } from "./ProofExec.mjs";
import {
  initializeProofDirectories,
  initializeProofRoot,
  proofCredentials,
  proofEnvironment,
  proofInput,
  verifyPatchResult,
} from "./ProofWorkspace.mjs";

function bootstrap(model) {
  return {
    type: "bootstrap",
    codex_home: "/home/codex",
    cwd: "/workspace",
    overrides: {
      check_for_update_on_startup: false,
      "analytics.enabled": false,
      "feedback.enabled": false,
      model: proofModel,
      model_provider: "mock",
      "model_providers.mock": {
        name: "Mock",
        base_url: model.baseUrl ?? "http://localhost/v1",
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: model.supportsWebSockets ?? true,
        stream_idle_timeout_ms: model.streamIdleTimeoutMs ?? 5000,
      },
      // The WASI connector requires an explicit proxy decision before opening a host socket.
      "features.respect_system_proxy": true,
      "features.shell_snapshot": false,
      "features.unified_exec": true,
    },
  };
}

export function createProofFacet(engine, createHost, options = {}) {
  return class extends DurableObject {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/model-proof-records")
        return Response.json({ records: readProofModelCpu(this.ctx) });
      if (path !== "/startup" && path !== "/turn")
        return new Response("Not found", { status: 404 });
      const turnMode = path === "/turn";
      if (turnMode && !createHost) throw new Error("Turn proof requires the real Bash module");
      const cleanupErrors = [],
        execTranscript = [],
        importCalls = [],
        memoryMilestones = [];
      const mock = createMockResponses();
      const execution = { pending: false, enteredAt: null };
      const model =
        options.model?.({ mock, request, context: this.ctx, execution }) ??
        createLocalProofModel({ mock, request });
      const stdoutDecoder = new TextDecoder(),
        stderrDecoder = new TextDecoder();
      let filesystem, binding, wakes, pipe, host, sessions, memory, driver, watchdog, composition;
      let peak = 0,
        ready = false,
        stdout = "",
        stderr = "",
        exit,
        failure,
        turnResult,
        proofContent,
        compositionResult;
      let modelResult;
      const sample = () => {
        if (memory) peak = Math.max(peak, memory.buffer.byteLength);
      };
      const milestone = (phase) => {
        sample();
        memoryMilestones.push({ phase, linearMemoryBytes: memory?.buffer.byteLength ?? null });
      };
      const closeInput = () => pipe?.closeWriter();
      const cleanup = async (name, action) => {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push({ name, error: String(error) });
        }
      };
      try {
        const storage = createFacetSqliteStorage(
          this.ctx.storage,
          () => BigInt(Date.now()) * 1000000n,
        );
        initializeProofRoot(storage);
        wakes = new KernelWakeRegistry();
        pipe = new KernelPipe(wakes);
        driver = createAppServerDriver({
          sendLine(line) {
            const bytes = new TextEncoder().encode(line);
            if (pipe.tryWrite(bytes) !== bytes.length)
              throw new Error("App-server input exceeds pipe capacity");
          },
          closeInput,
        });
        filesystem = new KernelFileSystem({
          mounts: [{ path: "/", storage }],
          posix: { credentials: proofCredentials, umask: 0o022 },
          stdio: [
            proofInput(pipe),
            {
              supportsNonblocking: true,
              write(bytes) {
                sample();
                stdout += stdoutDecoder.decode(bytes, { stream: true });
                driver.write(bytes);
                if (driver.transcript.some((item) => item.message.method === "signalbox/ready")) {
                  ready = true;
                  if (!turnMode) closeInput();
                }
                return bytes.length;
              },
            },
            {
              supportsNonblocking: true,
              write(bytes) {
                sample();
                stderr += stderrDecoder.decode(bytes, { stream: true });
                return bytes.length;
              },
            },
          ],
        });
        initializeProofDirectories(filesystem);
        host = createHost
          ? await createHost(wakes, {
              filesystem,
              storage,
              env: this.env,
              context: this.ctx,
              request,
            })
          : new KernelProgramHost({ registry: new KernelProgramRegistry(), wakes });
        composition = options.configure?.({
          filesystem,
          storage,
          facetStorage: this.ctx.storage,
          host,
          wakes,
          env: this.env,
        });
        binding = createKernelAsyncWasi({
          filesystem,
          wakes,
          agentOsPreopens: true,
          options: { version: "preview1", args: ["/bin/codex"], env: proofEnvironment },
        });
        sessions = createProofExec({ filesystem, host, transcript: execTranscript, cleanupErrors });
        const fsHost = new AgentOsFileSystemHost({
          memory: () => memory,
          fileSystem: filesystem,
          agentOsPreopens: true,
        });
        const descriptors = new AgentOsDescriptorHost({
          memory: () => memory,
          descriptors: filesystem.descriptors,
          wakes,
          asyncMode: true,
        });
        const processes = new AgentOsProcessHost({
          memory: () => memory,
          processes: host.processes,
          wakes,
          ...(composition?.parent === undefined ? {} : { parent: composition.parent }),
          ...(composition?.signal === undefined ? {} : { signal: composition.signal }),
          spawn:
            composition?.spawn ??
            (async () =>
              kernelError("UNSUPPORTED", "Direct guest spawning is outside the exec-server proof")),
        });
        const ws = createProofWebSocket({
          memory: () => memory,
          binding,
          sessions,
          context: this.ctx,
          modelRoute: model.route,
          execSocket: model.execSocket,
        });
        const http = createMockHttpAdapter({
          memory: () => memory,
          descriptors: binding.descriptors,
          mock,
          ...(model.http === undefined ? {} : { handleRequest: model.http }),
        });
        const imports = {
          ...binding.wasi.getImportObject(),
          ...fsHost.getImportObject(),
          ...ws.getImportObject(),
          host_process: {
            ...descriptors.getImportObject().host_process,
            ...processes.getImportObject().host_process,
          },
          host_user: { isatty: () => 0 },
          ...http.getImportObject(),
        };
        for (const name of Object.keys(imports)) imports[name] = { ...imports[name] };
        for (const descriptor of WebAssembly.Module.imports(engine)) {
          const { module, name } = descriptor;
          imports[module] ??= {};
          imports[module][name] ??= () => {
            throw new Error(`Unimplemented proof import ${module}.${name}`);
          };
          const value = imports[module][name];
          // JSPI's Suspending objects remain intact; this trace covers plain host imports only.
          if (typeof value === "function")
            imports[module][name] = (...args) => {
              sample();
              importCalls.push({
                name: `${module}.${name}`,
                args: args.map((arg) => (typeof arg === "bigint" ? String(arg) : arg)),
              });
              if (importCalls.length > 120) importCalls.shift();
              return value(...args);
            };
        }
        const initial = bootstrap(model);
        const configuredInitial = composition?.bootstrap?.(initial) ?? initial;
        driver.transcript.push({ direction: "to-engine", message: configuredInitial });
        const bytes = new TextEncoder().encode(JSON.stringify(configuredInitial) + "\n");
        if (pipe.tryWrite(bytes) !== bytes.length)
          throw new Error("Bootstrap exceeds pipe capacity");
        const driven = turnMode
          ? driver
              .run(
                model.cpuOnly
                  ? { prompt: "Reply with the CPU proof message. Do not call tools." }
                  : undefined,
              )
              .then(
                (result) => {
                  turnResult = result;
                },
                (error) => {
                  failure = String(error);
                  closeInput();
                },
              )
          : undefined;
        watchdog = setTimeout(() => {
          failure ??= "Engine proof exceeded its milestone budget";
          driver.fail(new Error(failure));
          wakes.dispose();
        }, model.watchdogMs ?? 30000);
        milestone("before-instance");
        const instance = new WebAssembly.Instance(engine, imports);
        memory = instance.exports.memory;
        milestone("after-instance");
        execution.enteredAt = Date.now();
        execution.pending = true;
        try {
          exit = await binding.wasi.start(instance);
        } finally {
          execution.pending = false;
        }
        milestone("after-start");
        if (!ready) driver.fail(new Error("Engine exited before signalbox/ready"));
        await driven;
        if (driver.failure) throw driver.failure;
        if (turnMode && turnResult) {
          modelResult = await model.inspect?.();
          if ((modelResult?.phase ?? mock.phase) !== "complete")
            throw new Error("Mock Responses sequence did not complete");
          if (model.metrics) {
            model.metrics.httpFallbacks = mock.requests.length - model.metrics.mockCalls;
            if (model.metrics.opens < 1 || model.metrics.httpFallbacks !== 0)
              throw new Error("Default Responses proof did not stay on WebSockets");
          }
          if (model.cpuOnly) {
            if (execTranscript.some((entry) => entry.method === "process/start"))
              throw new Error("CPU proof executed a tool");
            const messages = driver.transcript.filter(
              (entry) =>
                entry.direction === "from-engine" &&
                entry.message.method === "item/completed" &&
                entry.message.params?.item?.type === "agentMessage",
            );
            if (!messages.some((entry) => entry.message.params.item.text === "CPU proof complete."))
              throw new Error("CPU proof did not deliver its complete native message");
            proofContent = "CPU proof complete.";
          } else proofContent = verifyPatchResult(filesystem);
        }
        compositionResult = await composition?.verify?.({ filesystem, turnResult, mock, driver });
      } catch (error) {
        failure = `${error}\n${error.stack ?? ""}`;
        driver?.fail(error);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        sample();
        closeInput();
        await cleanup("proof-composition", () => composition?.finish?.({ exit, failure }));
        await cleanup("exec-sessions", () => sessions?.dispose());
        await cleanup("process-table", async () => {
          if (!host) return;
          const result = await host.processes.dispose();
          if (result.status !== "ok") throw new Error(JSON.stringify(result));
        });
        await cleanup("wasi", () => binding?.wasi.close());
        await cleanup("filesystem", () => filesystem?.dispose());
        await cleanup("input-pipe", () => pipe?.closeReader());
        await cleanup("wakes", () => wakes?.dispose());
      }
      stdout += stdoutDecoder.decode();
      stderr += stderrDecoder.decode();
      return Response.json({
        ok:
          ready &&
          exit === 0 &&
          !failure &&
          !cleanupErrors.length &&
          (!turnMode || !!proofContent) &&
          (compositionResult?.ok ?? true),
        scope: turnMode ? "real-engine-turn" : "real-engine-startup",
        ready,
        exit,
        failure,
        cleanupErrors,
        stdout,
        stderr,
        peakLinearMemoryBytes: peak,
        memoryMilestones,
        totalPeakMemoryBytes: null,
        totalPeakMemoryUnavailable: "This host does not expose total isolate peak memory",
        appServerTranscript: driver?.transcript ?? [],
        execTranscript,
        importCalls,
        mockPhase: mock.phase,
        modelRequests: mock.requests,
        modelTransport: modelResult ?? model.metrics ?? model.diagnostics?.(),
        proofContent,
        ...(compositionResult === undefined ? {} : { compositionResult }),
      });
    }
  };
}
