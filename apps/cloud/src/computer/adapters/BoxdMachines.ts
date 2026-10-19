// @effect-diagnostics globalDate:off - Boxd TTLs are absolute provider deadlines.
import { Boxd, NotFoundError } from "@boxd-sh/sdk/web";
import * as Option from "effect/Option";
import {
  MachineCreationError,
  type Machine,
  type MachineCreateInput,
  type MachineHandle,
  type MachineReconciliation,
} from "../Machine.ts";

const BOXD_BASE_URL = "https://boxd.sh:9443";
const BOXD_TIMEOUT_MS = 10_000;
const DEAD_PROXY_PORT = 65535;
const MACHINE_COMMAND: string[] = ["sleep", "infinity"];

/** Boxd create/fork have no idempotency keys, so callers must use this client. */
export const boxdMachineClient = (token: string) =>
  new Boxd({
    token,
    baseURL: BOXD_BASE_URL,
    timeout: BOXD_TIMEOUT_MS,
    maxRetries: 0,
  });

export interface BoxdMachineRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly shared: boolean;
  readonly networking: {
    readonly isolated: boolean;
    readonly networks: ReadonlyArray<string>;
  };
  readonly deleteAt: Date | null;
}

export interface BoxdMachineClient {
  readonly machines: {
    readonly create: (input: {
      readonly name: string;
      readonly org: string;
      readonly image: string;
      readonly isolated: true;
      readonly networks: string[];
      readonly shared: false;
      readonly deleteAfter: number;
      readonly cmd: string[];
      readonly restartPolicy: "never";
      readonly config: {
        readonly vcpu: number;
        readonly memory: string;
        readonly ssh: false;
        readonly autoSuspendTimeout: 0;
        readonly autoDestroyTimeout: number;
        readonly idleIgnoreOutbound: true;
      };
    }) => Promise<unknown>;
    readonly fork: (
      source: string,
      input: {
        readonly name: string;
        readonly isolated: true;
        readonly networks: string[];
        readonly shared: false;
        readonly deleteAfter: number;
      },
    ) => Promise<unknown>;
    readonly get: (name: string) => Promise<BoxdMachineRecord | null>;
    readonly delete: (id: string) => Promise<unknown>;
    readonly setDeleteAfter: (name: string, seconds: number) => Promise<unknown>;
    readonly proxies: {
      readonly setPort: (name: string, port: number) => Promise<unknown>;
      readonly list: (name: string) => Promise<
        ReadonlyArray<{
          readonly isDefault: boolean;
          readonly port: number;
          readonly portMode: string;
        }>
      >;
    };
  };
}

export interface BoxdMachineReservation {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly createStarted: boolean;
  readonly machineId: string | null;
}

/** Every method commits to persistent storage before returning. */
export interface BoxdMachineReservations {
  /** Reuses the same reservation for an operationId and persists its exact name first. */
  readonly reserve: (input: MachineCreateInput) => Promise<BoxdMachineReservation>;
  /** Lookup-only recovery. This must not create a reservation or dispatch a machine. */
  readonly lookup: (input: MachineCreateInput) => Promise<BoxdMachineReservationLookup>;
  /** Atomically marks the one allowed create/fork dispatch; false means it already started. */
  readonly startCreate: (reservation: BoxdMachineReservation) => Promise<boolean>;
  readonly recordMachineId: (
    reservation: BoxdMachineReservation,
    machineId: string,
  ) => Promise<void>;
  /** Call only after exact-name lookup confirms provider absence. */
  readonly release: (reservation: BoxdMachineReservation) => Promise<void>;
}

export type BoxdMachineReservationLookup =
  | { readonly status: "missing" }
  | { readonly status: "active"; readonly reservation: BoxdMachineReservation }
  | { readonly status: "released"; readonly reservation: BoxdMachineReservation };

export interface BoxdMachinesConfig {
  readonly org: string;
  readonly image: string;
  readonly vcpu: number;
  readonly memory: string;
}

export class BoxdMachinePendingError extends MachineCreationError {
  constructor(name: string) {
    super("unknown", `Boxd machine ${name} is not ready yet.`);
    this.name = "BoxdMachinePendingError";
  }
}

const ttl = (expiresAt: number, now: number) => {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new RangeError("Boxd machine expiry must be in the future.");
  }
  return Math.max(1, Math.ceil((expiresAt - now) / 1_000));
};

const abortIfNeeded = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Boxd machine creation failed.";

const get = async (client: BoxdMachineClient, name: string) => {
  try {
    return (await client.machines.get(name)) ?? null;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
};

const isPrivate = (machine: BoxdMachineRecord) =>
  machine.shared === false &&
  machine.networking.isolated === true &&
  machine.networking.networks.length === 0;

export const makeBoxdMachines = (
  client: BoxdMachineClient,
  reservations: BoxdMachineReservations,
  config: BoxdMachinesConfig,
  now: () => number = Date.now,
): Machine => {
  const deleteOwnedMachine = async (reservation: BoxdMachineReservation, machineId: string) => {
    const current = await get(client, reservation.name);
    if (current) {
      if (current.name !== reservation.name || current.id !== machineId) {
        throw new Error("Boxd machine ownership changed before release.");
      }
      await client.machines.delete(current.id);
    }
    if (await get(client, reservation.name)) {
      throw new Error("Boxd machine deletion is not confirmed.");
    }
  };

  const removeOwned = async (reservation: BoxdMachineReservation, machineId: string) => {
    await deleteOwnedMachine(reservation, machineId);
    await reservations.release(reservation);
  };

  const handle = (
    reservation: BoxdMachineReservation,
    machine: BoxdMachineRecord,
  ): MachineHandle => ({
    id: machine.id,
    generation: reservation.generation,
    release: () => removeOwned(reservation, machine.id),
  });

  const prepare = async (
    reservation: BoxdMachineReservation,
    machine: BoxdMachineRecord,
    expiresAt: number,
    seconds: number,
    signal: AbortSignal,
  ) => {
    if (machine.name !== reservation.name || !machine.id) {
      throw new Error("Boxd machine identity does not match its reservation.");
    }
    if (reservation.machineId !== null && reservation.machineId !== machine.id) {
      throw new Error("Boxd machine id changed for an owned reservation.");
    }
    if (machine.status !== "running") throw new BoxdMachinePendingError(reservation.name);

    try {
      if (!isPrivate(machine)) throw new Error("Boxd machine isolation mismatch.");
      await client.machines.setDeleteAfter(reservation.name, seconds);
      await client.machines.proxies.setPort(reservation.name, DEAD_PROXY_PORT);
      const proxies = await client.machines.proxies.list(reservation.name);
      if (
        proxies.length !== 1 ||
        !proxies[0]?.isDefault ||
        proxies[0].port !== DEAD_PROXY_PORT ||
        proxies[0].portMode !== "locked"
      ) {
        throw new Error("Boxd default public route is not pinned to the dead port.");
      }

      const refreshed = await get(client, reservation.name);
      if (
        !refreshed ||
        refreshed.id !== machine.id ||
        refreshed.name !== reservation.name ||
        !isPrivate(refreshed) ||
        !refreshed.deleteAt ||
        refreshed.deleteAt.getTime() > expiresAt + 5_000 ||
        refreshed.deleteAt.getTime() <= now()
      ) {
        throw new Error("Boxd machine security or deletion horizon mismatch.");
      }

      await reservations.recordMachineId(reservation, refreshed.id);
      const result = handle(reservation, refreshed);
      if (signal.aborted) {
        await result.release();
        abortIfNeeded(signal);
      }
      return result;
    } catch (error) {
      if (error instanceof BoxdMachinePendingError) throw error;
      try {
        await deleteOwnedMachine(reservation, machine.id);
      } catch (cleanupError) {
        throw new MachineCreationError(
          "unknown",
          "Boxd machine was unsafe and exact cleanup is still pending.",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      try {
        await reservations.release(reservation);
      } catch (releaseError) {
        throw new MachineCreationError(
          "not_created",
          "Boxd machine was removed, but its reservation could not be released.",
          { cause: new AggregateError([error, releaseError]) },
        );
      }
      throw new MachineCreationError("not_created", messageOf(error), { cause: error });
    }
  };

  return {
    create: async (input, signal) => {
      let dispatchMayHaveStarted = false;
      try {
        abortIfNeeded(signal);
        const base = Option.isSome(input.base) ? input.base.value : null;
        if (base && base.expiresAt !== input.expiresAt) {
          throw new RangeError("Machine expiry must match the Base lease expiry.");
        }
        const seconds = ttl(input.expiresAt, now());
        const reservation = await reservations.reserve(input);
        if (!reservation.id || !reservation.name || reservation.generation < 0) {
          throw new Error("Boxd machine reservation is invalid.");
        }
        dispatchMayHaveStarted = reservation.createStarted;
        abortIfNeeded(signal);

        let machine = await get(client, reservation.name);
        if (machine) {
          if (!reservation.createStarted) {
            throw new Error("A Boxd machine already uses the reserved name.");
          }
          return await prepare(reservation, machine, input.expiresAt, seconds, signal);
        }
        if (reservation.createStarted) throw new BoxdMachinePendingError(reservation.name);

        abortIfNeeded(signal);
        // A failed marker write can be committed even when its acknowledgement is lost.
        dispatchMayHaveStarted = true;
        const shouldCreate = await reservations.startCreate(reservation);
        if (!shouldCreate) {
          const resumed = await reservations.reserve(input);
          machine = await get(client, reservation.name);
          if (!machine) throw new BoxdMachinePendingError(reservation.name);
          if (!resumed.createStarted) throw new Error("Boxd machine reservation state changed.");
          return await prepare(resumed, machine, input.expiresAt, seconds, signal);
        }

        if (signal.aborted) {
          const reason = signal.reason ?? new DOMException("Aborted", "AbortError");
          if (await get(client, reservation.name)) {
            throw new MachineCreationError(
              "unknown",
              "A Boxd machine appeared before the canceled create was dispatched.",
              { cause: reason },
            );
          }
          try {
            await reservations.release(reservation);
          } catch (releaseError) {
            throw new MachineCreationError(
              "not_created",
              "Machine creation was canceled before dispatch; reservation cleanup is pending.",
              { cause: new AggregateError([reason, releaseError]) },
            );
          }
          throw new MachineCreationError("not_created", messageOf(reason), { cause: reason });
        }

        if (base) {
          await client.machines.fork(base.sourceRef, {
            name: reservation.name,
            isolated: true,
            networks: [],
            shared: false,
            deleteAfter: seconds,
          });
        } else {
          await client.machines.create({
            name: reservation.name,
            org: config.org,
            image: config.image,
            isolated: true,
            networks: [],
            shared: false,
            deleteAfter: seconds,
            cmd: MACHINE_COMMAND,
            restartPolicy: "never",
            config: {
              vcpu: config.vcpu,
              memory: config.memory,
              ssh: false,
              autoSuspendTimeout: 0,
              autoDestroyTimeout: seconds,
              idleIgnoreOutbound: true,
            },
          });
        }

        machine = await get(client, reservation.name);
        if (!machine) throw new BoxdMachinePendingError(reservation.name);
        return await prepare(reservation, machine, input.expiresAt, seconds, signal);
      } catch (error) {
        if (error instanceof MachineCreationError) throw error;
        throw new MachineCreationError(
          dispatchMayHaveStarted ? "unknown" : "not_created",
          messageOf(error),
          { cause: error },
        );
      }
    },
    reconcile: async (input, signal): Promise<MachineReconciliation> => {
      abortIfNeeded(signal);
      const lookup = await reservations.lookup(input);
      if (lookup.status === "missing") {
        return {
          status: "absent",
          absence: {
            operationId: input.operationId,
            reservationId: null,
            name: null,
            generation: null,
            machineId: null,
            createStarted: false,
            reservationReleased: false,
            providerAbsent: true,
          },
          releaseReservation: async () => undefined,
        };
      }

      const { reservation } = lookup;
      const machine = await get(client, reservation.name);
      abortIfNeeded(signal);
      if (!machine) {
        if (lookup.status === "released") {
          return {
            status: "absent",
            absence: {
              operationId: input.operationId,
              reservationId: reservation.id,
              name: reservation.name,
              generation: reservation.generation,
              machineId: reservation.machineId,
              createStarted: reservation.createStarted,
              reservationReleased: true,
              providerAbsent: true,
            },
            releaseReservation: async () => undefined,
          };
        }
        if (!reservation.createStarted || reservation.machineId) {
          return {
            status: "absent",
            absence: {
              operationId: input.operationId,
              reservationId: reservation.id,
              name: reservation.name,
              generation: reservation.generation,
              machineId: reservation.machineId,
              createStarted: reservation.createStarted,
              reservationReleased: false,
              providerAbsent: true,
            },
            releaseReservation: () => reservations.release(reservation),
          };
        }
        return { status: "unknown" };
      }

      if (
        lookup.status !== "active" ||
        !reservation.createStarted ||
        machine.name !== reservation.name ||
        !machine.id ||
        (reservation.machineId !== null && reservation.machineId !== machine.id)
      ) {
        return { status: "unknown" };
      }

      return {
        status: "owned",
        handle: handle(reservation, machine),
        ownership: {
          operationId: input.operationId,
          machineId: machine.id,
          generation: reservation.generation,
        },
      };
    },
  };
};
