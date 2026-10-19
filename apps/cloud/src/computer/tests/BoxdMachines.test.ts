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
  expiresAt: NOW + 900_000,
});

const fixture = () => {
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
      }),
      fork: vi.fn(async (_source, options) => {
        events.push("fork");
        machines.set(options.name, machine(options.name));
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
            deleteAt: DateTime.toDate(DateTime.makeUnsafe(NOW + seconds * 1_000)),
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
  const port = makeBoxdMachines(
    client,
    reservations,
    { org: "test-org", image: "runner-image", vcpu: 1, memory: "4G" },
    () => NOW,
  );
  return { client, events, machines, port, reservations, state };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      deleteAfter: 900,
      cmd: ["sleep", "infinity"],
      restartPolicy: "never",
      config: {
        vcpu: 1,
        memory: "4G",
        ssh: false,
        autoSuspendTimeout: 0,
        autoDestroyTimeout: 900,
        idleIgnoreOutbound: true,
      },
    });
    expect(f.client.machines.setDeleteAfter).toHaveBeenCalledWith(NAME, 900);
    expect(f.client.machines.proxies.setPort).toHaveBeenCalledWith(NAME, 65535);
    expect(handle).toMatchObject({ id: MACHINE_ID, generation: 7 });
    expect(f.reservations.recordMachineId).toHaveBeenCalledWith(expect.anything(), MACHINE_ID);
  });

  it("forks only the supplied Base source and keeps its expiry", async () => {
    const f = fixture();
    const lease: BaseLease = {
      id: "base-lease-1",
      sourceRef: "opaque-boxd-source",
      expiresAt: NOW + 900_000,
    };

    await f.port.create(input(Option.some(lease)), new AbortController().signal);

    expect(f.client.machines.create).not.toHaveBeenCalled();
    expect(f.client.machines.fork).toHaveBeenCalledWith("opaque-boxd-source", {
      name: NAME,
      isolated: true,
      networks: [],
      shared: false,
      deleteAfter: 900,
    });
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
