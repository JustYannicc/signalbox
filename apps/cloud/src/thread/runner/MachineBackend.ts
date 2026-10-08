import type { MachineEnsureRequest } from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Where a thread's machines come from, and the only code that knows which
 * provider runs them. A thread has one machine; `ensure` brings it up with a
 * Runner at a generation, `stop` lets it go, `destroy` removes it for good,
 * and `inspect` reports it. All four are idempotent, so a duplicate alarm or a
 * lost provider response is retried safely.
 *
 * Backends keep a `MachineRecord` in the thread's object and write the state
 * the thread wants before they act, so whatever a crash interrupts is picked
 * up by the next try. Every real machine also has a hard TTL at its provider,
 * so a thread object that is gone for good cannot leak one.
 *
 * Backends, chosen by the Worker's vars:
 * - `boat` (`MACHINE_BACKEND=boat`): a boat VM per thread, the heavy class
 *   (`boat/BoatMachineBackend.ts`).
 * - `local`: development only, a Runner host on the developer's own machine
 *   (`node apps/server/src/signalbox/runner/main.ts`) at `LOCAL_RUNNER_URL`.
 *   It only counts under `LOCAL_WORKERD`, so a deployed Worker never calls a
 *   URL someone left in its vars.
 *
 * Machines hold no provider keys, so a backend is only usable together with a
 * ModelGateway (`MODEL_GATEWAY_URL`), which every machine is told about.
 */

export interface MachineBackendEnv {
  /** Set by `vp run dev` only. */
  readonly LOCAL_WORKERD?: string;
  /** A local Runner host, e.g. `http://localhost:8790`. */
  readonly LOCAL_RUNNER_URL?: string;
  /** The ModelGateway Worker's origin, e.g. `http://127.0.0.1:8788`. */
  readonly MODEL_GATEWAY_URL?: string;
  /** `boat` to run threads on boat VMs. */
  readonly MACHINE_BACKEND?: string;
  /** The cloud's public origin, which machines' Runners dial. */
  readonly CLOUD_URL?: string;
  /** The Runner image machines run. */
  readonly RUNNER_IMAGE?: string;
  readonly BOAT_API_KEY?: string;
  readonly BOAT_API_URL?: string;
  /** `small` (2 vCPU / 4 GB, the default), `default` or `large`. */
  readonly BOAT_MACHINE_TYPE?: string;
  /** The hard TTL of each wake, in seconds. */
  readonly BOAT_TTL_SECONDS?: string;
}

export class MachineBackendError extends Schema.TaggedError<MachineBackendError>()(
  "MachineBackendError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** What a backend last saw of the thread's machine, against what the thread wants. */
export interface MachineStatus {
  readonly desired: MachineRecord["desired"];
  readonly actual: "none" | "starting" | "running" | "stopping" | "stopped" | "failed";
  /** The provider's id for the machine, once it has one. */
  readonly machineId: string | null;
  /** Why the machine is not where the thread wants it, for logs. */
  readonly detail?: string;
}

export interface MachineBackendShape {
  readonly kind: "none" | "local" | "boat";
  /** How long a requested machine may take until its Runner says hello. */
  readonly connectTimeoutMs: number;
  /**
   * Brings the machine up with a Runner at `generation`. Done when `actual` is
   * `running`; until then, ask again.
   */
  readonly ensure: (
    request: Omit<MachineEnsureRequest, "modelGatewayUrl">,
  ) => Effect.Effect<MachineStatus, MachineBackendError>;
  /** Stops the machine. Cheap when it already is: no provider call. */
  readonly stop: (threadId: ThreadId) => Effect.Effect<MachineStatus, MachineBackendError>;
  readonly destroy: (threadId: ThreadId) => Effect.Effect<MachineStatus, MachineBackendError>;
  readonly inspect: (threadId: ThreadId) => Effect.Effect<MachineStatus, MachineBackendError>;
  /**
   * Pushes the machine's hard TTL out again, counted from now. The thread calls
   * it every `refreshEveryMs` while a turn runs, so only an abandoned machine
   * ever reaches its TTL.
   */
  readonly refresh: (threadId: ThreadId) => Effect.Effect<void, MachineBackendError>;
  /** How often `refresh` is due while the machine works; null when it has no TTL. */
  readonly refreshEveryMs: number | null;
  /** Whether a stop or destroy the provider has not accepted yet is outstanding. */
  readonly pending: Effect.Effect<boolean>;
}

export class MachineBackend extends Context.Service<MachineBackend, MachineBackendShape>()(
  "@signalbox/cloud/thread/runner/MachineBackend",
) {}

/**
 * The thread's machine as a backend recorded it. Written before every provider
 * call, so the next try knows what was asked even if no answer came back.
 */
export interface MachineRecord {
  /** The provider's id for the machine, once it named one. */
  readonly machineId: string | null;
  /** Idempotency key of a create the provider may have accepted; reused until it names the machine. */
  readonly createKey: string | null;
  readonly desired: "running" | "stopped" | "destroyed";
  /** Whether the provider accepted `desired`. Until then the thread's alarm keeps asking. */
  readonly settled: boolean;
}

export const NO_MACHINE_RECORD: MachineRecord = {
  machineId: null,
  createKey: null,
  desired: "stopped",
  settled: true,
};

/** The thread object's one `MachineRecord`. */
export class MachineRecords extends Context.Service<
  MachineRecords,
  {
    readonly get: Effect.Effect<MachineRecord>;
    readonly save: (record: MachineRecord) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/runner/MachineBackend/MachineRecords") {}

/** Default connect timeout: a machine that is already there and only starts a Runner. */
export const CONNECT_TIMEOUT_MS = 60_000;
