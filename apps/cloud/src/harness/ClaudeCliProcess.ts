import type { ClaudeSdkRequest } from "./ClaudeSdkHostTypes.ts";
import { RpcTarget } from "cloudflare:workers";
import type { HarnessOpenInput } from "./Harness.ts";
import type { HarnessProcessObserver, HarnessRuntimeReporter } from "./HarnessProcessLifetime.ts";
import type { NodeHarnessBaseInput, NodeHarnessProcess } from "./NodeHarnessProcess.ts";
import { abortableValue, applySdkLaunch } from "./claude/SdkRelease.ts";
import { createClaudeInitializationProgress } from "./claude/InitializationProgress.ts";
import { captureClaudeSpawnDiagnostic } from "./claude/SpawnContext.ts";
import { observeClaudeModelTransport } from "./claude/TurnProgress.ts";
import type {
  ClaudeCliLaunch,
  ClaudeCliProcessPort,
  ClaudeSdkReport,
} from "./ClaudeSdkHostProtocol.ts";
import type { ClaudeToolHookInput } from "./ClaudeToolObservation.ts";
import { ownRpcResponse } from "../rpc/response.ts";

export interface ClaudeCliProcessOptions extends Omit<NodeHarnessBaseInput, "signal"> {
  readonly launch: (input: NodeHarnessBaseInput) => NodeHarnessProcess;
  readonly files: {
    call(
      operation: string,
      args: ReadonlyArray<unknown>,
      signal?: AbortSignal,
    ): Promise<import("./ClaudeSdkHostProtocol.ts").ClaudeSdkFsReply>;
    close(): Promise<void>;
  };
}

/** The CLI Worker owns its personality and one verified launch; Computer owns mutable kernel state. */
export class ClaudeCliProcess extends RpcTarget implements ClaudeCliProcessPort {
  readonly #process;
  readonly #release;
  readonly #launch = abortableValue<ClaudeCliLaunch>();
  readonly #started = abortableValue<void>();
  readonly #files;
  readonly #reporter;
  readonly #transport;
  readonly #observation;
  readonly #lifetime = new AbortController();
  readonly #unsubscribe;
  readonly #continuation;
  readonly #io = new Map<string, AbortController>();
  readonly #cancelledIo = new Map<string, unknown>();
  #streamsTaken = false;
  #launched = false;
  #disposed: Promise<void> | undefined;

  constructor(
    options: ClaudeCliProcessOptions,
    input: Omit<HarnessOpenInput<unknown>, "computer"> & {
      readonly computer: NodeHarnessBaseInput["computer"];
    },
    reporter: HarnessRuntimeReporter,
    observation?: (
      input: ClaudeToolHookInput,
      toolUseId: string | undefined,
      signal: AbortSignal,
    ) => Promise<void>,
    continuation?: (request: unknown, signal: AbortSignal) => Promise<void>,
  ) {
    super();
    const loaded = input.loadedRelease ?? options.loadedRelease;
    if (
      input.release.harness !== "claude-code" ||
      input.computer !== options.computer ||
      loaded === undefined ||
      loaded.plan.release.manifestSha256 !== input.release.manifestSha256
    )
      throw new Error("Claude CLI launch does not own the verified release and Computer");
    this.#release = input.release;
    this.#reporter = reporter;
    this.#transport = input.modelTransport;
    this.#observation = observation;
    this.#continuation = continuation;
    this.#files = options.files;
    const initialization =
      reporter.turnMilestone === undefined
        ? undefined
        : createClaudeInitializationProgress(reporter.turnMilestone);
    this.#unsubscribe =
      initialization === undefined
        ? () => undefined
        : options.stdio.observeAcceptedWrites(initialization.acceptedWrite);
    const processInput: NodeHarnessBaseInput = {
      ...options,
      loadedRelease: loaded,
      signal: this.#lifetime.signal,
      modelTransport: observeClaudeModelTransport(
        input.modelTransport,
        reporter.turnMilestone ?? (() => undefined),
      ),
      reportReleaseModuleOmitted: reporter.releaseModuleOmitted,
      reportCliStartupFailure: (cause) => {
        try {
          options.reportCliStartupFailure?.(cause);
        } finally {
          reporter.cliStartupFailure?.(cause);
        }
      },
      loadRelease: async (bridge, signal) => {
        const request = await this.#launch.wait(signal);
        applySdkLaunch(bridge, processInput, { ...request, signal });
        const release = await options.loadRelease(bridge, signal);
        return release;
      },
      onLaunch: () => {
        this.#started.resolve();
        try {
          options.onLaunch?.();
        } finally {
          initialization?.cliSpawned();
        }
      },
    };
    // Capture the installed context after SDK argv/environment mapping, before CLI evaluation.
    const loadRelease = processInput.loadRelease;
    this.#process = options.launch({
      ...processInput,
      loadRelease: async (bridge, signal) => {
        const release = await loadRelease(bridge, signal);
        reporter.cliSpawnContext?.(captureClaudeSpawnDiagnostic(bridge));
        return release;
      },
    });
    void this.#process.exited.then(
      (status) =>
        this.#started.reject(
          new Error("Claude exited before launch acknowledgement", { cause: status }),
        ),
      (cause: unknown) => this.#started.reject(cause),
    );
  }

  observeOwner(observer: HarnessProcessObserver | undefined) {
    observer?.started(this.#process);
  }

  async streams() {
    if (this.#streamsTaken) throw new Error("Claude process streams already have an SDK owner");
    this.#streamsTaken = true;
    return {
      stdin: this.#process.stdin,
      stdout: this.#process.stdout,
      stderr: this.#process.stderr,
    };
  }

  async launch(request: ClaudeCliLaunch) {
    try {
      if (
        this.#launched ||
        this.#lifetime.signal.aborted ||
        request.manifestSha256 !== this.#release.manifestSha256
      )
        throw new Error("Claude launch is duplicate, closed, or belongs to another release");
      this.#launched = true;
      this.#launch.resolve(request);
      await this.#started.wait(this.#lifetime.signal);
    } catch (cause) {
      this.#launch.reject(cause);
      throw cause;
    }
  }

  async exited() {
    return await this.#process.exited;
  }
  async assertCompatibility() {
    await this.#process.assertCompatibility();
  }
  async signal(reason: unknown, signal: 9 | 15) {
    if (signal !== 9 && signal !== 15) throw new Error("Unsupported Claude CLI signal");
    // Native exit precedes pipe drainage. A late SDK kill must leave final output alone.
    if (this.#process.exitStatus !== undefined) return;
    await this.#process.abort(reason, signal);
  }
  async report(report: ClaudeSdkReport) {
    if (report.type === "milestone") this.#reporter.turnMilestone?.(report.stage);
    else if (report.type === "spawn") this.#reporter.cliSpawnContext?.(report.context);
    else if (report.type === "trace") this.#reporter.cliViewTrace?.(report.event);
    else await this.#reporter.releaseModuleOmitted(report.event, report.failure);
  }
  #beginOperation(id: string) {
    this.#lifetime.signal.throwIfAborted();
    if (this.#io.has(id)) throw new Error("Duplicate Claude I/O operation");
    const controller = new AbortController();
    if (this.#cancelledIo.has(id)) {
      controller.abort(this.#cancelledIo.get(id));
      this.#cancelledIo.delete(id);
    }
    this.#io.set(id, controller);
    return AbortSignal.any([this.#lifetime.signal, controller.signal]);
  }
  async #operation<A>(id: string, run: (signal: AbortSignal) => Promise<A>) {
    const signal = this.#beginOperation(id);
    try {
      signal.throwIfAborted();
      return await run(signal);
    } finally {
      this.#io.delete(id);
    }
  }
  async cancelIo(id: string, reason: unknown) {
    const active = this.#io.get(id);
    if (active !== undefined) active.abort(reason);
    else if (this.#cancelledIo.size < 64) this.#cancelledIo.set(id, reason);
  }
  async model(id: string, request: ClaudeSdkRequest) {
    const signal = this.#beginOperation(id);
    try {
      signal.throwIfAborted();
      const response = await this.#transport(
        new Request(request.url, {
          method: request.method,
          headers: request.headers.map(([key, value]) => [key, value]),
          redirect: request.redirect,
          body: request.body,
          signal,
        }),
      );
      return await ownRpcResponse(response, {
        signal,
        release: () => {
          this.#io.delete(id);
        },
        bodyOpened() {},
        bodyClosed() {},
        bodyBytes() {},
        socketOpened() {},
        socketClosed() {},
      });
    } catch (cause) {
      this.#io.delete(id);
      throw cause;
    }
  }
  async observeTool(input: ClaudeToolHookInput, toolUseId: string | undefined) {
    await this.#observation?.(input, toolUseId, this.#lifetime.signal);
  }
  async fs(id: string, operation: string, args: ReadonlyArray<unknown>) {
    return await this.#operation(id, (signal) => this.#files.call(operation, args, signal));
  }
  async continuation(request: unknown) {
    if (this.#continuation === undefined)
      throw new Error("Claude continuation publisher is unavailable");
    await this.#continuation(request, this.#lifetime.signal);
  }
  dispose() {
    return (this.#disposed ??= (async () => {
      this.#lifetime.abort(new Error("Claude CLI owner closed"));
      this.#launch.reject(this.#lifetime.signal.reason);
      // Process teardown still needs kernel streams and descriptor capabilities.
      const settled = await Promise.allSettled([this.#process.dispose()]);
      settled.push(...(await Promise.allSettled([this.#files.close()])));
      this.#unsubscribe();
      const failures = settled
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Claude CLI cleanup failed");
    })());
  }
}
