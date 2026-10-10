// @effect-diagnostics globalTimers:off globalDate:off - readiness polling runs on the Durable Object's own clock.
import { machineEnsureJson } from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type MachineBackendShape,
  MachineBackendError,
  type MachineRequest,
  type MachineStatus,
} from "../MachineBackend.ts";

/**
 * The light class (#113, #134): a Cloudflare Container (`basic`, ¼ vCPU and
 * 1 GiB) bound to the thread's own object (`containers` in `wrangler.jsonc`),
 * so `ctx.container` is the thread's machine and nothing else can start it.
 * It starts in well under a second with a fresh disk every time, which is all
 * a light thread needs: its files come from its drive and its session from the
 * thread (#131, #132). The thread stops it after a 30-second idle tail.
 *
 * The container runs the Runner image built with the Worker, as a Runner host
 * listening on `RUNNER_PORT`; `ensure` hands it each generation the way the
 * `local` backend does (`POST /machines/ensure`), and the host replaces the
 * thread's older Runner. Each generation names its class, so a light
 * machine's Runner moves a turn that needs more to the heavy class.
 *
 * Containers stop on their own once their object has been idle for
 * `INACTIVITY_TIMEOUT_MS`, which is the hard TTL: an object that is gone for
 * good cannot leak one. A container that exits without being asked (out of
 * memory, a crash) while running a generation it was handed is reported
 * through `onExit`.
 *
 * Tests use a fake `Container`; vitest cannot run containers.
 */

/** Where the Runner host listens in the container. */
export const RUNNER_PORT = 8790;

/** The instance type `wrangler.jsonc` gives the thread object's containers. */
const INSTANCE_TYPE = "basic";

/** #110: the light class's idle tail. */
const IDLE_TAIL_MS = 30_000;

/**
 * How long the container outlives its object going idle. A working machine's
 * Runner wakes the object at least every half minute, so only a container
 * whose object is gone reaches it.
 */
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;

/** A cold start is under a second, then Node loads the Runner. */
const CONNECT_TIMEOUT_MS = 2 * 60_000;

/** How long one `ensure` waits for the Runner host to listen before asking again later. */
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 200;

const HOME = "/home/node/signalbox";
const RUNNER = "/opt/signalbox/runner.mjs";

export interface CloudflareMachineSettings {
  /** The cloud's public origin, which the Runner dials. */
  readonly cloudUrl: string;
  readonly modelGatewayUrl: string;
}

export interface CloudflareMachineBackendInput {
  readonly container: Container;
  readonly settings: CloudflareMachineSettings;
  /** The container running `generation` stopped without being asked to; `detail` says how. */
  readonly onExit: (detail: string, generation: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const exitDetail = (cause: unknown) => {
  const code =
    typeof cause === "object" && cause !== null && "exitCode" in cause ? cause.exitCode : undefined;
  if (code === 137) return "The machine ran out of memory (exit 137).";
  if (code !== undefined) return `The machine exited with code ${String(code)}.`;
  return `The machine stopped: ${cause instanceof Error ? cause.message : String(cause)}`;
};

export const makeCloudflareMachineBackend = ({
  container,
  settings,
  onExit,
}: CloudflareMachineBackendInput): MachineBackendShape => {
  /** A stop under way. */
  let stopping: Promise<void> | null = null;
  /** The running container: whether its exit was asked for, and the last generation it took. */
  let current: { asked: boolean; generation: number | null } | null = null;

  /**
   * Reports the running container's exit, unless a stop asked for it. One that
   * never took a generation from this object (it restarted since) is left to
   * the Runner's socket going quiet.
   */
  const watch = () => {
    const watched: { asked: boolean; generation: number | null } = {
      asked: false,
      generation: null,
    };
    current = watched;
    const exited = (detail: string) => {
      if (!watched.asked && watched.generation !== null) onExit(detail, watched.generation);
    };
    container.monitor().then(
      () => exited("The machine's Runner exited."),
      (cause: unknown) => exited(exitDetail(cause)),
    );
  };
  // A container that outlived its object's restart has lost its timeout and its watcher.
  if (container.running) {
    void container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    watch();
  }

  const destroy = () => {
    if (current !== null) current.asked = true;
    stopping ??= container
      .destroy()
      .catch(() => {})
      .finally(() => {
        stopping = null;
      });
    return stopping;
  };

  const start = async (request: MachineRequest) => {
    container.start({
      entrypoint: [
        "node",
        RUNNER,
        "--cloud",
        settings.cloudUrl,
        "--port",
        String(RUNNER_PORT),
        "--listen",
        "0.0.0.0",
        "--home",
        HOME,
        "--machine-id",
        `cloudflare:${request.threadId}`,
      ],
      enableInternet: true,
    });
    watch();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  };

  /** Hands the Runner host `request`'s generation; false while it is not listening yet. */
  const handOver = async (request: MachineRequest) => {
    const body = machineEnsureJson.encode({
      threadId: request.threadId,
      generation: request.generation,
      token: request.token,
      modelGatewayUrl: settings.modelGatewayUrl,
      machineClass: request.machineClass,
    });
    const startedAt = performance.now();
    while (performance.now() - startedAt < READY_TIMEOUT_MS) {
      if (!container.running) throw new Error("The machine exited while starting.");
      let response: Response;
      try {
        response = await container.getTcpPort(RUNNER_PORT).fetch("http://runner/machines/ensure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      } catch {
        // Not listening yet.
        await sleep(READY_POLL_MS);
        continue;
      }
      const text = await response.text();
      if (response.ok) {
        if (current !== null) current.generation = request.generation;
        return true;
      }
      throw new Error(`The machine's Runner refused: ${response.status} ${text}`);
    }
    return false;
  };

  const status = (
    actual: MachineStatus["actual"],
    desired: MachineStatus["desired"],
    threadId: ThreadId,
    extra: Pick<MachineStatus, "detail" | "wake"> = {},
  ): MachineStatus => ({
    desired,
    actual,
    machineId: actual === "none" ? null : `cloudflare:${threadId}`,
    ...extra,
  });

  const attempt = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new MachineBackendError({
          message: `Cloudflare container ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });

  const letGo = (desired: "stopped" | "destroyed") => (threadId: ThreadId) =>
    attempt("stop", async () => {
      if (container.running) {
        await destroy();
        return status("stopped", desired, threadId);
      }
      if (stopping !== null) await stopping;
      return status("none", desired, threadId);
    });

  return {
    kind: "cloudflare",
    shape: INSTANCE_TYPE,
    image: null,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    idleTailMs: IDLE_TAIL_MS,
    ensure: (request) =>
      attempt("ensure", async () => {
        if (stopping !== null) await stopping;
        if (!container.running) await start(request);
        // Cold until a Runner took its first generation, even across retries.
        const wake = current?.generation == null ? "cold" : "warm";
        return (await handOver(request))
          ? status("running", "running", request.threadId, { wake })
          : status("starting", "running", request.threadId, {
              wake,
              detail: "The Runner is not listening yet.",
            });
      }),
    stop: letGo("stopped"),
    destroy: letGo("destroyed"),
    // Nothing outlives a stop, so a container that is not running is none.
    inspect: (threadId) =>
      Effect.sync(() =>
        container.running
          ? status("running", "running", threadId)
          : status("none", "stopped", threadId),
      ),
    // The inactivity timeout counts from the object's last activity, so there is nothing to push out.
    refresh: () => Effect.void,
    refreshEveryMs: null,
    pending: Effect.sync(() => stopping !== null),
  };
};
