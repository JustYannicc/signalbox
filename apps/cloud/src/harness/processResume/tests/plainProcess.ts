// @effect-diagnostics nodeBuiltinImport:off - this fixture runs an ordinary Node child process.
import * as NodeChildProcess from "node:child_process";
import type {
  PlainGitWorkspaceSnapshot,
  PlainCheckpointFiles,
  PlainNativeState,
  PlainWorkspaceState,
} from "./checkpointFiles.ts";
import type { PlainGitWorkspace } from "./checkpointFiles.ts";

export interface PlainProcessReady {
  readonly processId: number;
  readonly processNonce: string;
  readonly nativeSessionId: string;
  readonly native: PlainNativeState;
  readonly workspace: PlainWorkspaceState;
  readonly checkpointDigest: string;
  readonly gitWorkspace: PlainGitWorkspaceSnapshot;
}

export interface PlainProcessCheckpoint {
  readonly requestId: string;
  readonly native: PlainNativeState;
  readonly workspace: PlainWorkspaceState;
}

export interface PlainProcessStepResult {
  readonly requestId: string;
  readonly native: PlainNativeState;
  readonly workspace: PlainWorkspaceState;
}

export interface PlainProcessJoin {
  readonly invocationRpc: boolean;
  readonly fetch: boolean;
  readonly ports: boolean;
  readonly processExit: boolean;
}

type Deferred<A> = {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (error: unknown) => void;
};

const deferred = <A>(): Deferred<A> => Promise.withResolvers<A>();

type ChildMessage =
  | {
      readonly type: "ready";
      readonly processId: number;
      readonly processNonce: string;
      readonly nativeSessionId: string;
      readonly native: PlainNativeState;
      readonly workspace: PlainWorkspaceState;
      readonly checkpointDigest: string;
      readonly gitWorkspace: PlainGitWorkspaceSnapshot;
    }
  | {
      readonly type: "checkpoint";
      readonly requestId: string;
      readonly native: PlainNativeState;
      readonly workspace: PlainWorkspaceState;
    }
  | { readonly type: "fetch-started"; readonly requestId: string }
  | {
      readonly type: "fetch-settled";
      readonly requestId: string;
      readonly fetchResult: { readonly requestId: string };
    }
  | {
      readonly type: "callback";
      readonly requestId: string;
      readonly fetchResult: { readonly requestId: string };
    }
  | {
      readonly type: "step-result";
      readonly requestId: string;
      readonly native: PlainNativeState;
      readonly workspace: PlainWorkspaceState;
    }
  | { readonly type: "stop-acknowledged"; readonly requestId: string };

type ParentMessage =
  | { readonly type: "step"; readonly requestId: string; readonly input: string }
  | { readonly type: "checkpoint-committed"; readonly requestId: string }
  | { readonly type: "release-callback"; readonly requestId: string }
  | { readonly type: "stop"; readonly requestId: string };

interface StepWaiters {
  readonly checkpoint: Deferred<PlainProcessCheckpoint>;
  readonly fetchStarted: Deferred<void>;
  readonly fetchSettled: Deferred<void>;
  readonly callback: Deferred<void>;
  readonly result: Deferred<PlainProcessStepResult>;
}

export class PlainProcess {
  readonly #child: NodeChildProcess.ChildProcess;
  readonly #ready = deferred<PlainProcessReady>();
  readonly #disconnected = deferred<void>();
  readonly #exited = deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  readonly #steps = new Map<string, StepWaiters>();
  readonly #stopAcks = new Map<string, Deferred<void>>();
  #failure: unknown;
  #stopRequest = 0;
  #stopAcknowledged = false;
  #admissionFenced = false;

  private constructor(child: NodeChildProcess.ChildProcess) {
    this.#child = child;
    child.on("message", (value: unknown) => this.#receive(value as ChildMessage));
    child.on("disconnect", () => this.#disconnected.resolve());
    child.on("exit", (code, signal) => this.#exited.resolve({ code, signal }));
    child.on("error", (error) => this.#fail(error));
  }

  static async open(
    files: PlainCheckpointFiles,
    fetchUrl: string,
    gitWorkspace: PlainGitWorkspace,
  ): Promise<PlainProcess> {
    const workerPath = new URL("./plainProcess.worker.ts", import.meta.url);
    const child = NodeChildProcess.fork(
      workerPath,
      [files.nativePath, files.workspacePath, fetchUrl, gitWorkspace.path],
      {
        execArgv: ["--experimental-strip-types"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const process = new PlainProcess(child);
    try {
      await process.#ready.promise;
    } catch (error) {
      child.kill();
      throw error;
    }
    return process;
  }

  get ready(): Promise<PlainProcessReady> {
    return this.#ready.promise;
  }

  invoke(requestId: string, input: string): Promise<PlainProcessStepResult> {
    if (this.#admissionFenced) throw new Error("Plain process admission is fenced after stop.");
    const waiters: StepWaiters = {
      checkpoint: deferred<PlainProcessCheckpoint>(),
      fetchStarted: deferred<void>(),
      fetchSettled: deferred<void>(),
      callback: deferred<void>(),
      result: deferred<PlainProcessStepResult>(),
    };
    if (this.#steps.has(requestId)) throw new Error("Plain process request ids must be unique.");
    this.#steps.set(requestId, waiters);
    void this.#send({ type: "step", requestId, input }).catch((error) => this.#fail(error));
    return waiters.result.promise;
  }

  checkpoint(requestId: string): Promise<PlainProcessCheckpoint> {
    return this.#step(requestId).checkpoint.promise;
  }

  fetchStarted(requestId: string): Promise<void> {
    return this.#step(requestId).fetchStarted.promise;
  }

  fetchSettled(requestId: string): Promise<void> {
    return this.#step(requestId).fetchSettled.promise;
  }

  callbackReceived(requestId: string): Promise<void> {
    return this.#step(requestId).callback.promise;
  }

  async checkpointCommitted(requestId: string): Promise<void> {
    await this.#send({ type: "checkpoint-committed", requestId });
  }

  async releaseCallback(requestId: string): Promise<void> {
    await this.#send({ type: "release-callback", requestId });
  }

  async stop(): Promise<{ readonly acknowledged: boolean }> {
    this.#admissionFenced = true;
    if (!this.#child.connected) return { acknowledged: this.#stopAcknowledged };
    const requestId = `stop-${++this.#stopRequest}`;
    const acknowledgement = deferred<void>();
    this.#stopAcks.set(requestId, acknowledgement);
    await this.#send({ type: "stop", requestId });
    await acknowledgement.promise;
    return { acknowledged: true };
  }

  async join(requestId?: string): Promise<PlainProcessJoin> {
    const waiters = requestId === undefined ? undefined : this.#steps.get(requestId);
    const result = waiters?.result.promise ?? Promise.resolve(undefined);
    const fetch = waiters?.fetchSettled.promise ?? Promise.resolve();
    const [stepResult, , , exit] = await Promise.all([
      result,
      fetch,
      this.#disconnected.promise,
      this.#exited.promise,
    ]);
    if (this.#failure !== undefined) throw this.#failure;
    if (waiters && !stepResult) throw new Error("Plain process invocation did not return.");
    if (exit.code !== 0) throw new Error(`Plain process exited with code ${String(exit.code)}.`);
    return { invocationRpc: true, fetch: true, ports: true, processExit: true };
  }

  async cleanup(requestId?: string): Promise<void> {
    if (requestId !== undefined && this.#child.connected) await this.releasePendingWork(requestId);
    const stopped = await this.stop();
    const joined = await this.join(requestId);
    if (!stopped.acknowledged || !joined.invocationRpc || !joined.fetch || !joined.ports)
      throw new Error("Plain process cleanup lacks stop and joined-settlement evidence.");
  }

  async releasePendingWork(requestId: string): Promise<void> {
    const waiters = this.#steps.get(requestId);
    if (!waiters) return;
    await waiters.checkpoint.promise;
    await this.checkpointCommitted(requestId);
    await waiters.callback.promise;
    await this.releaseCallback(requestId);
  }

  async #send(message: ParentMessage): Promise<void> {
    if (!this.#child.connected) throw new Error("Plain process IPC is closed.");
    await new Promise<void>((resolve, reject) => {
      this.#child.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }

  #step(requestId: string): StepWaiters {
    const step = this.#steps.get(requestId);
    if (!step) throw new Error(`Unknown plain process request ${requestId}.`);
    return step;
  }

  #receive(message: ChildMessage): void {
    if (message.type === "ready") {
      this.#ready.resolve(message);
      return;
    }
    if (message.type === "stop-acknowledged") {
      this.#stopAcknowledged = true;
      this.#stopAcks.get(message.requestId)?.resolve();
      return;
    }
    const step = this.#steps.get(message.requestId);
    if (!step) return;
    switch (message.type) {
      case "checkpoint":
        step.checkpoint.resolve(message);
        break;
      case "fetch-started":
        step.fetchStarted.resolve();
        break;
      case "fetch-settled":
        step.fetchSettled.resolve();
        break;
      case "callback":
        step.callback.resolve();
        break;
      case "step-result":
        step.result.resolve(message);
        break;
    }
  }

  #fail(error: unknown): void {
    this.#failure = error;
    this.#ready.reject(error);
    this.#steps.forEach((step) => {
      step.checkpoint.reject(error);
      step.fetchStarted.reject(error);
      step.fetchSettled.reject(error);
      step.callback.reject(error);
      step.result.reject(error);
    });
    this.#stopAcks.forEach((acknowledgement) => acknowledgement.reject(error));
  }
}
