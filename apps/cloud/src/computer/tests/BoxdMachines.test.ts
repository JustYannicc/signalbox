import * as Option from "effect/Option";
import { DateTime } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BoxdMachinePendingError,
  boxdMachineClient,
  makeBoxdMachines,
  type BoxdMachineClient,
  type BoxdMachineRecord,
  type BoxdMachineReservation,
  type BoxdMachineReservations,
} from "../BoxdMachines.ts";
import type { BaseLease, DriveRef, RecipeHash } from "../Computer.ts";
import { MachineCreationError, type Machine } from "../Machine.ts";

const NOW = 1_800_000_000_000;
const NAME = "sb-command-op-1";
const MACHINE_ID = "boxd-machine-1";

const machine = (name: string, fields: Partial<BoxdMachineRecord> = {}): BoxdMachineRecord => ({
  id: MACHINE_ID,
  name,
  status: "running",
  shared: false,
  networking: { isolated: true, networks: [] },
  idle: { destroyAfter: 0 },
  deleteAt: null,
  ...fields,
});

const input = (
  base: Option.Option<BaseLease> = Option.none(),
): Parameters<Machine["create"]>[0] => ({
  operationId: "op-1",
  drive: "my/personal/alice" as DriveRef,
  recipeHash: "sha256:abc" as RecipeHash,
  base,
  expiresAt: Option.isSome(base) ? base.value.expiresAt : NOW + 900_000,
});

const fixture = (
  now: () => number = () => NOW,
  makeTimeoutSignal?: (milliseconds: number) => AbortSignal,
) => {
  const events: string[] = [];
  const machines = new Map<string, BoxdMachineRecord>();
  const state = { createStarted: false, machineId: null as string | null, released: false };
  const currentReservation = (): BoxdMachineReservation => ({
    id: "reservation-1",
    name: NAME,
    generation: 7,
    createStarted: state.createStarted,
    machineId: state.machineId,
  });
  const reservations: BoxdMachineReservations = {
    reserve: vi.fn(async () => {
      events.push("reserve");
      return currentReservation();
    }),
    lookup: vi.fn(async () => ({
      status: state.released ? ("released" as const) : ("active" as const),
      reservation: currentReservation(),
    })),
    startCreate: vi.fn(async () => {
      events.push("startCreate");
      if (state.createStarted) return false;
      state.createStarted = true;
      return true;
    }),
    recordMachineId: vi.fn(async (_reservation, id) => {
      events.push("recordMachineId");
      state.machineId = id;
    }),
    release: vi.fn(async () => {
      events.push("releaseReservation");
      state.released = true;
    }),
  };
  const client: BoxdMachineClient = {
    machines: {
      create: vi.fn(async (options) => {
        events.push("create");
        machines.set(options.name, machine(options.name));
        return { id: MACHINE_ID };
      }),
      fork: vi.fn(async (_source, options) => {
        events.push("fork");
        machines.set(
          options.name,
          machine(options.name, {
            idle: { destroyAfter: options.config?.autoDestroyTimeout ?? 600 },
          }),
        );
        return { id: MACHINE_ID };
      }),
      get: vi.fn(async (name) => {
        events.push(`get:${name}`);
        return machines.get(name) ?? null;
      }),
      delete: vi.fn(async (id) => {
        events.push(`delete:${id}`);
        for (const [name, current] of machines) {
          if (current.id === id) machines.delete(name);
        }
      }),
      setDeleteAfter: vi.fn(async (name, seconds) => {
        events.push("setDeleteAfter");
        const current = machines.get(name);
        if (current) {
          machines.set(name, {
            ...current,
            deleteAt:
              seconds === 0 ? null : DateTime.toDate(DateTime.makeUnsafe(NOW + seconds * 1_000)),
          });
        }
      }),
      proxies: {
        setPort: vi.fn(async () => {
          events.push("setDeadPort");
        }),
        list: vi.fn(async () => {
          events.push("listProxies");
          return [{ isDefault: true, port: 65535, portMode: "locked" }];
        }),
      },
    },
  };
  const port = makeTimeoutSignal
    ? makeBoxdMachines(
        client,
        reservations,
        { org: "test-org", image: "runner-image", vcpu: 1, memory: "4G" },
        now,
        makeTimeoutSignal,
      )
    : makeBoxdMachines(
        client,
        reservations,
        { org: "test-org", image: "runner-image", vcpu: 1, memory: "4G" },
        now,
      );
  return { client, events, machines, port, reservations, state };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BoxdMachines", () => {
  it("persists an exact reservation before creating one isolated private VM", async () => {
    const f = fixture();
    const handle = await f.port.create(input(), new AbortController().signal);
    const options = vi.mocked(f.client.machines.create).mock.calls[0]?.[0];

    expect(f.events.indexOf("reserve")).toBeLessThan(f.events.indexOf("create"));
    expect(f.events.indexOf("startCreate")).toBeLessThan(f.events.indexOf("create"));
    expect(options).toEqual({
      name: NAME,
      org: "test-org",
      image: "runner-image",
      isolated: true,
      networks: [],
      shared: false,
      deleteAfter: 0,
      cmd: ["sleep", "infinity"],
      restartPolicy: "never",
      config: {
        vcpu: 1,
        memory: "4G",
        ssh: false,
        autoSuspendTimeout: 0,
        autoDestroyTimeout: 0,
        idleIgnoreOutbound: true,
      },
    });
    expect(f.client.machines.setDeleteAfter).toHaveBeenCalledWith(NAME, 0);
    expect(f.client.machines.proxies.setPort).toHaveBeenCalledWith(NAME, 65535);
    expect(handle).toMatchObject({ id: MACHINE_ID, generation: 7 });
    expect(f.reservations.recordMachineId).toHaveBeenCalledWith(expect.anything(), MACHINE_ID);
  });

  it("retries public status probes until Boxd reports running", async () => {
    const f = fixture();
    let signalPendingStatus!: () => void;
    const pendingStatus = new Promise<void>((resolve) => {
      signalPendingStatus = resolve;
    });
    let reads = 0;
    vi.mocked(f.client.machines.create).mockImplementationOnce(async (options) => {
      f.events.push("create-pending");
      f.machines.set(options.name, machine(options.name, { status: "pending" }));
      return { id: MACHINE_ID };
    });
    vi.mocked(f.client.machines.get).mockImplementation(async (name) => {
      f.events.push(`get:${name}`);
      reads += 1;
      const current = f.machines.get(name) ?? null;
      if (reads === 2) {
        signalPendingStatus();
        throw new Error("temporary Boxd status failure");
      }
      if (reads === 4 && current) {
        const ready = { ...current, status: "running" as const };
        f.machines.set(name, ready);
        return ready;
      }
      return current;
    });

    vi.useFakeTimers();
    const creation = f.port.create(input(), new AbortController().signal);
    await pendingStatus;
    await vi.advanceTimersByTimeAsync(1_000);
    const handle = await creation;

    expect(reads).toBeGreaterThanOrEqual(4);
    expect(f.events.indexOf("create-pending")).toBeLessThan(f.events.lastIndexOf(`get:${NAME}`));
    expect(handle.id).toBe(MACHINE_ID);
    expect(f.client.machines.create).toHaveBeenCalledTimes(1);
  });

  it("stops waiting on an SDK status lookup when the caller aborts", async () => {
    const f = fixture();
    let signalLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let finishLookup!: (machine: BoxdMachineRecord | null) => void;
    const unresponsiveLookup = new Promise<BoxdMachineRecord | null>((resolve) => {
      finishLookup = resolve;
    });
    let reads = 0;
    vi.mocked(f.client.machines.create).mockImplementationOnce(async (options) => {
      f.machines.set(options.name, machine(options.name, { status: "pending" }));
      return { id: MACHINE_ID };
    });
    vi.mocked(f.client.machines.get).mockImplementation(async (_name) => {
      reads += 1;
      if (reads === 1) return null;
      signalLookupStarted();
      return unresponsiveLookup;
    });
    const controller = new AbortController();
    const creation = f.port.create(input(), controller.signal);
    await lookupStarted;
    controller.abort(new Error("cancelled while waiting for Boxd"));

    await expect(creation).rejects.toMatchObject({
      disposition: "unknown",
      message: "cancelled while waiting for Boxd",
    });
    expect(f.client.machines.create).toHaveBeenCalledTimes(1);
    expect(f.client.machines.delete).not.toHaveBeenCalled();
    expect(f.reservations.release).not.toHaveBeenCalled();
    finishLookup(null);
  });

  it("bounds a hung status lookup without releasing its reservation", async () => {
    vi.useFakeTimers();
    const f = fixture(undefined, (milliseconds) => {
      const deadline = new AbortController();
      setTimeout(
        () => deadline.abort(new DOMException("Readiness timed out", "TimeoutError")),
        milliseconds,
      );
      return deadline.signal;
    });
    let signalLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let finishLookup!: (machine: BoxdMachineRecord | null) => void;
    const unresponsiveLookup = new Promise<BoxdMachineRecord | null>((resolve) => {
      finishLookup = resolve;
    });
    let reads = 0;
    vi.mocked(f.client.machines.create).mockImplementationOnce(async (options) => {
      f.machines.set(options.name, machine(options.name, { status: "pending" }));
      return { id: MACHINE_ID };
    });
    vi.mocked(f.client.machines.get).mockImplementation(async (_name) => {
      reads += 1;
      if (reads === 1) return null;
      signalLookupStarted();
      return unresponsiveLookup;
    });

    const creation = f.port.create(input(), new AbortController().signal);
    const creationResult = creation.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await lookupStarted;
    await vi.advanceTimersByTimeAsync(90_000);
    const result = await creationResult;
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Readiness probe unexpectedly resolved");
    expect(result.error).toMatchObject({
      disposition: "unknown",
      message: expect.stringContaining("readiness deadline"),
    });

    expect(f.client.machines.delete).not.toHaveBeenCalled();
    expect(f.reservations.release).not.toHaveBeenCalled();
    finishLookup(null);
  });

  it("forks only the supplied Base source and clears machine deletion timers", async () => {
    const f = fixture();
    const lease: BaseLease = {
      id: "base-lease-1",
      sourceRef: "opaque-boxd-source",
      expiresAt: NOW + 900_000,
      retention: "until-release",
    };

    await f.port.create(input(Option.some(lease)), new AbortController().signal);

    expect(f.client.machines.create).not.toHaveBeenCalled();
    expect(f.client.machines.fork).toHaveBeenCalledWith("opaque-boxd-source", {
      name: NAME,
      isolated: true,
      networks: [],
      shared: false,
      deleteAfter: 0,
      config: {
        autoSuspendTimeout: 0,
        autoDestroyTimeout: 0,
        idleIgnoreOutbound: true,
      },
    });
  });

  it("rejects a legacy expiring Base before reserving or forking", async () => {
    const f = fixture();
    const legacyLease: BaseLease = {
      id: "legacy-base",
      sourceRef: "opaque-boxd-source",
      expiresAt: NOW + 900_000,
    };

    await expect(
      f.port.create(input(Option.some(legacyLease)), new AbortController().signal),
    ).rejects.toMatchObject({ disposition: "not_created" });

    expect(f.reservations.reserve).not.toHaveBeenCalled();
    expect(f.client.machines.fork).not.toHaveBeenCalled();
  });

  it("rejects a warm fork when the provider still reports an inherited destroy timer", async () => {
    const f = fixture();
    const lease: BaseLease = {
      id: "base-lease-1",
      sourceRef: "opaque-boxd-source",
      expiresAt: NOW + 900_000,
      retention: "until-release",
    };
    vi.mocked(f.client.machines.setDeleteAfter).mockImplementationOnce(async (name, seconds) => {
      const current = f.machines.get(name);
      if (current) {
        f.machines.set(name, {
          ...current,
          deleteAt: seconds === 0 ? null : current.deleteAt,
          idle: { destroyAfter: 60 },
        });
      }
    });

    await expect(
      f.port.create(input(Option.some(lease)), new AbortController().signal),
    ).rejects.toMatchObject({
      disposition: "not_created",
      message: "Boxd machine security or deletion timer mismatch.",
    });

    expect(f.client.machines.delete).toHaveBeenCalledWith(MACHINE_ID);
    expect(f.reservations.release).toHaveBeenCalledTimes(1);
    expect(f.reservations.recordMachineId).not.toHaveBeenCalled();
  });

  it("checks a Base fork deadline again after the reservation write", async () => {
    let clock = NOW;
    const f = fixture(() => clock);
    const lease: BaseLease = {
      id: "base-lease-1",
      sourceRef: "opaque-boxd-source",
      expiresAt: NOW + 1_000,
      retention: "until-release",
    };
    vi.mocked(f.reservations.reserve).mockImplementationOnce(async () => {
      f.events.push("reserve");
      clock = NOW + 1_001;
      return {
        id: "reservation-1",
        name: NAME,
        generation: 7,
        createStarted: false,
        machineId: null,
      };
    });

    await expect(
      f.port.create(input(Option.some(lease)), new AbortController().signal),
    ).rejects.toMatchObject({
      disposition: "not_created",
    });

    expect(f.reservations.startCreate).not.toHaveBeenCalled();
    expect(f.client.machines.fork).not.toHaveBeenCalled();
  });

  it("releases a reservation when the Base expires before fork dispatch", async () => {
    let clock = NOW;
    const f = fixture(() => clock);
    const lease: BaseLease = {
      id: "base-lease-1",
      sourceRef: "opaque-boxd-source",
      expiresAt: NOW + 1_000,
      retention: "until-release",
    };
    vi.mocked(f.reservations.startCreate).mockImplementationOnce(async () => {
      f.events.push("startCreate");
      f.state.createStarted = true;
      clock = NOW + 1_001;
      return true;
    });

    await expect(
      f.port.create(input(Option.some(lease)), new AbortController().signal),
    ).rejects.toMatchObject({ disposition: "not_created" });

    expect(f.client.machines.fork).not.toHaveBeenCalled();
    expect(f.reservations.release).toHaveBeenCalledTimes(1);
  });

  it("recovers an ambiguous create by exact name without repeating the mutation", async () => {
    const f = fixture();
    vi.mocked(f.client.machines.create).mockImplementationOnce(async (options) => {
      f.events.push("create-timeout");
      f.machines.set(options.name, machine(options.name));
      throw new Error("provider timed out after create");
    });

    const error = await f.port
      .create(input(), new AbortController().signal)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MachineCreationError);
    expect(error).toMatchObject({ disposition: "unknown" });
    expect(error).toHaveProperty("cause");
    const handle = await f.port.create(input(), new AbortController().signal);

    expect(f.client.machines.get).toHaveBeenCalledWith(NAME);
    expect(f.client.machines.create).toHaveBeenCalledTimes(1);
    expect(handle.id).toBe(MACHINE_ID);
  });

  it("does not repeat an ambiguous create while the reserved name is still absent", async () => {
    const f = fixture();
    vi.mocked(f.client.machines.create).mockRejectedValueOnce(new Error("provider timeout"));

    await expect(f.port.create(input(), new AbortController().signal)).rejects.toMatchObject({
      _tag: "MachineCreationError",
      disposition: "unknown",
      message: "provider timeout",
    });
    await expect(f.port.create(input(), new AbortController().signal)).rejects.toBeInstanceOf(
      BoxdMachinePendingError,
    );

    expect(f.client.machines.create).toHaveBeenCalledTimes(1);
    expect(f.client.machines.get).toHaveBeenCalledWith(NAME);
  });

  it("keeps ownership when deletion is uncertain and releases it after verified absence", async () => {
    const f = fixture();
    const handle = await f.port.create(input(), new AbortController().signal);
    vi.mocked(f.client.machines.delete).mockRejectedValueOnce(new Error("delete uncertain"));

    await expect(handle.release()).rejects.toThrow("delete uncertain");
    expect(f.reservations.release).not.toHaveBeenCalled();

    await handle.release();

    expect(f.client.machines.delete).toHaveBeenCalledTimes(2);
    expect(f.client.machines.delete).toHaveBeenNthCalledWith(1, MACHINE_ID);
    expect(f.client.machines.delete).toHaveBeenNthCalledWith(2, MACHINE_ID);
    expect(f.machines.size).toBe(0);
    expect(f.reservations.release).toHaveBeenCalledTimes(1);
    expect(f.state.released).toBe(true);
  });

  it("deletes an exact reserved VM that fails the private isolation check", async () => {
    const f = fixture();
    vi.mocked(f.client.machines.create).mockImplementationOnce(async (options) => {
      f.machines.set(options.name, machine(options.name, { shared: true }));
      return { id: MACHINE_ID };
    });

    await expect(f.port.create(input(), new AbortController().signal)).rejects.toMatchObject({
      _tag: "MachineCreationError",
      disposition: "not_created",
      message: "Boxd machine isolation mismatch.",
    });

    expect(f.client.machines.delete).toHaveBeenCalledWith(MACHINE_ID);
    expect(f.machines.size).toBe(0);
    expect(f.reservations.release).toHaveBeenCalledTimes(1);
  });

  it("does not reserve or create when already cancelled", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(f.port.create(input(), controller.signal)).rejects.toMatchObject({
      _tag: "MachineCreationError",
      disposition: "not_created",
      message: "cancelled",
    });

    expect(f.reservations.reserve).not.toHaveBeenCalled();
    expect(f.client.machines.create).not.toHaveBeenCalled();
  });

  it("releases an absent reservation when cancelled after reserving but before dispatch", async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.reservations.startCreate).mockImplementationOnce(async () => {
      f.events.push("startCreate");
      f.state.createStarted = true;
      controller.abort(new Error("cancelled before dispatch"));
      return true;
    });

    await expect(f.port.create(input(), controller.signal)).rejects.toMatchObject({
      _tag: "MachineCreationError",
      disposition: "not_created",
      message: "cancelled before dispatch",
    });

    expect(f.client.machines.create).not.toHaveBeenCalled();
    expect(f.reservations.release).toHaveBeenCalledTimes(1);
  });

  it("uses an SDK client with automatic retries disabled", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("unreachable"));
    vi.stubGlobal("fetch", fetch);
    const client = boxdMachineClient("test-token");

    try {
      await expect(client.machines.list({})).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });
});
