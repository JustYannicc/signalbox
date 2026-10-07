import { machineConfigJson } from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as Platform from "../../../platform.ts";
import type { MachineSettings } from "../machineBackends.ts";
import { type MachineRecord, NO_MACHINE_RECORD } from "../MachineBackend.ts";
import { type BoatApi, BoatApiError, type BoatSandbox } from "./BoatApi.ts";
import { CONFIG_PATH, makeBoatMachineBackend } from "./BoatMachineBackend.ts";

const threadId = ThreadId.make("thread-boat");

const settings: Extract<MachineSettings, { kind: "boat" }> = {
  kind: "boat",
  apiUrl: "https://boat.test/api/v1",
  apiKey: Redacted.make("key"),
  cloudUrl: "https://cloud.test",
  modelGatewayUrl: "https://gateway.test",
  image: "ghcr.io/test/runner:1",
  machineType: "small",
  ttlSeconds: 3600,
};

type Operation = "create" | "get" | "setTtl" | "resume" | "stop" | "delete" | "writeFile";

/**
 * boat as far as a thread's machine sees it: idempotent creates, a sandbox that
 * boots, stops and resumes, and answers that can be lost after boat acted.
 */
const makeFakeBoat = () => {
  const sandboxes = new Map<
    string,
    { state: string; setupStatus?: string; files: Map<string, string> }
  >();
  const keys = new Map<string, string>();
  const calls: Array<Operation> = [];
  const lose = new Set<Operation>();
  const refuse = new Set<Operation>();
  let created = 0;

  const answer = <A>(operation: Operation, act: () => A) =>
    Effect.suspend(() => {
      calls.push(operation);
      if (refuse.delete(operation)) {
        return Effect.fail(
          new BoatApiError({ operation, status: 409, code: "conflict", message: "Not now." }),
        );
      }
      const result = act();
      // boat did it, but the answer never arrived.
      if (lose.delete(operation)) {
        return Effect.fail(
          new BoatApiError({ operation, status: 0, code: null, message: "Lost." }),
        );
      }
      return Effect.succeed(result);
    });
  const sandboxOf = (id: string): BoatSandbox => {
    const { state, setupStatus } = sandboxes.get(id)!;
    return { id, state, ...(setupStatus === undefined ? {} : { setupStatus }) };
  };

  const api: BoatApi = {
    create: (_request, key) =>
      answer("create", () => {
        const existing = keys.get(key);
        if (existing !== undefined) return sandboxOf(existing);
        created += 1;
        const id = `bx_${created}`;
        sandboxes.set(id, { state: "provisioning", files: new Map() });
        keys.set(key, id);
        return sandboxOf(id);
      }),
    get: (id) => answer("get", () => (sandboxes.has(id) ? sandboxOf(id) : null)),
    setTtl: (id) =>
      answer("setTtl", () => {
        if (!sandboxes.has(id)) throw new Error("No such sandbox.");
      }),
    resume: (id) =>
      answer("resume", () => {
        sandboxes.get(id)!.state = "provisioning";
      }),
    stop: (id) =>
      answer("stop", () => {
        sandboxes.get(id)!.state = "archiving";
      }),
    remove: (id) =>
      answer("delete", () => {
        sandboxes.delete(id);
      }),
    writeFile: (id, path, content) =>
      answer("writeFile", () => {
        sandboxes.get(id)!.files.set(path, content);
      }),
  };
  return {
    api,
    sandboxes,
    calls,
    lose: (operation: Operation) => lose.add(operation),
    refuse: (operation: Operation) => refuse.add(operation),
    /** Every sandbox finishes what it was doing. */
    settle: () => {
      for (const sandbox of sandboxes.values()) {
        if (sandbox.state === "provisioning") sandbox.state = "ready";
        if (sandbox.state === "archiving") sandbox.state = "archived";
      }
    },
    config: (id: string) => {
      const text = sandboxes.get(id)?.files.get(CONFIG_PATH);
      return text === undefined ? null : machineConfigJson.decode(text);
    },
  };
};

/** The thread object's storage; a new backend over the same store is the object waking again. */
const makeStore = () => {
  let record: MachineRecord = NO_MACHINE_RECORD;
  return {
    records: {
      get: Effect.sync(() => record),
      save: (next: MachineRecord) =>
        Effect.sync(() => {
          record = next;
        }),
    },
    current: () => record,
  };
};

const makeBackend = (boat: ReturnType<typeof makeFakeBoat>, store: ReturnType<typeof makeStore>) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return makeBoatMachineBackend({ settings, api: boat.api, records: store.records, crypto });
  }).pipe(Effect.provide(Platform.layerCrypto));

const request = (generation: number) => ({ threadId, generation, token: `token-${generation}` });

describe("BoatMachineBackend", () => {
  it.effect("starts one VM on demand and hands its Runner the generation", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const backend = yield* makeBackend(boat, makeStore());
      expect((yield* backend.ensure(request(1))).actual).toBe("starting");
      // The alarm asks again while the VM boots: still one VM.
      expect((yield* backend.ensure(request(1))).actual).toBe("starting");
      boat.settle();
      const up = yield* backend.ensure(request(1));
      expect(up).toMatchObject({ desired: "running", actual: "running", machineId: "bx_1" });
      expect(boat.sandboxes.size).toBe(1);
      expect(boat.config("bx_1")).toEqual({
        threadId,
        generation: 1,
        token: "token-1",
        modelGatewayUrl: settings.modelGatewayUrl,
        cloudUrl: settings.cloudUrl,
        image: settings.image,
      });
    }),
  );

  it.effect("a lost create answer, retried after the object went down, finds the same VM", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const store = makeStore();
      boat.lose("create");
      const first = yield* makeBackend(boat, store);
      const lost = yield* Effect.flip(first.ensure(request(1)));
      expect(lost.message).toContain("create");
      expect(store.current()).toMatchObject({ desired: "running", machineId: null });
      // A fresh object over the same storage: the persisted key finds the VM boat made.
      const again = yield* makeBackend(boat, store);
      yield* again.ensure(request(1));
      boat.settle();
      expect((yield* again.ensure(request(1))).actual).toBe("running");
      expect(boat.sandboxes.size).toBe(1);
      expect(boat.calls.filter((call) => call === "create")).toHaveLength(2);
    }),
  );

  it.effect("stops after the tail, resumes the same VM for the next message", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const store = makeStore();
      const backend = yield* makeBackend(boat, store);
      yield* backend.ensure(request(1));
      boat.settle();
      yield* backend.ensure(request(1));

      expect((yield* backend.stop(threadId)).actual).toBe("stopping");
      expect(yield* backend.pending).toBe(false);
      // Stopping again is a no-op: no second call to boat.
      yield* backend.stop(threadId);
      expect(boat.calls.filter((call) => call === "stop")).toHaveLength(1);
      boat.settle();
      expect(boat.sandboxes.get("bx_1")?.state).toBe("archived");

      expect((yield* backend.ensure(request(2))).detail).toContain("Resuming");
      boat.settle();
      expect((yield* backend.ensure(request(2))).actual).toBe("running");
      expect(boat.sandboxes.size).toBe(1);
      expect(boat.config("bx_1")?.generation).toBe(2);
    }),
  );

  it.effect("a lost stop answer or a refused stop is retried until boat takes it", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const backend = yield* makeBackend(boat, makeStore());
      yield* backend.ensure(request(1));
      boat.settle();
      yield* backend.ensure(request(1));

      boat.lose("stop");
      yield* Effect.flip(backend.stop(threadId));
      expect(yield* backend.pending).toBe(true);
      // boat stopped it although the answer was lost; asking again settles it.
      yield* backend.stop(threadId);
      expect(yield* backend.pending).toBe(false);

      yield* backend.ensure(request(2));
      boat.settle();
      yield* backend.ensure(request(2));
      boat.refuse("stop");
      expect((yield* backend.stop(threadId)).actual).toBe("running");
      expect(yield* backend.pending).toBe(true);
      yield* backend.stop(threadId);
      expect(yield* backend.pending).toBe(false);
      expect(boat.sandboxes.get("bx_1")?.state).toBe("archiving");
    }),
  );

  it.effect("a VM deleted at boat is replaced, and destroy removes it for good", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const store = makeStore();
      const backend = yield* makeBackend(boat, store);
      yield* backend.ensure(request(1));
      boat.sandboxes.delete("bx_1");
      expect((yield* backend.ensure(request(1))).actual).toBe("starting");
      yield* backend.ensure(request(1));
      boat.settle();
      expect((yield* backend.ensure(request(1))).machineId).toBe("bx_2");

      expect((yield* backend.destroy(threadId)).actual).toBe("none");
      expect(boat.sandboxes.size).toBe(0);
      expect(store.current()).toMatchObject({ desired: "destroyed", machineId: null });
    }),
  );

  it.effect("a VM whose setup failed is deleted and replaced", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const backend = yield* makeBackend(boat, makeStore());
      yield* backend.ensure(request(1));
      boat.settle();
      boat.sandboxes.get("bx_1")!.setupStatus = "failed";
      expect((yield* backend.ensure(request(1))).actual).toBe("failed");
      expect(boat.sandboxes.has("bx_1")).toBe(false);
      yield* backend.ensure(request(1));
      boat.settle();
      expect(yield* backend.ensure(request(1))).toMatchObject({
        actual: "running",
        machineId: "bx_2",
      });
    }),
  );

  it.effect("a VM made by a create whose answer was lost is found again and stopped", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const store = makeStore();
      const backend = yield* makeBackend(boat, store);
      boat.lose("create");
      yield* Effect.flip(backend.ensure(request(1)));
      // The run was stopped before anyone asked again: the thread lets the machine go.
      expect((yield* backend.stop(threadId)).actual).toBe("stopping");
      expect(boat.sandboxes.get("bx_1")?.state).toBe("archiving");
      expect(store.current()).toMatchObject({ machineId: "bx_1", settled: true });
      expect(boat.sandboxes.size).toBe(1);
    }),
  );

  it.effect("keeps a working VM's TTL pushed out, and refreshes nothing without a VM", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat();
      const backend = yield* makeBackend(boat, makeStore());
      yield* backend.refresh(threadId);
      expect(boat.calls).not.toContain("setTtl");
      yield* backend.ensure(request(1));
      yield* backend.refresh(threadId);
      expect(boat.calls.filter((call) => call === "setTtl")).toHaveLength(1);
      expect(backend.refreshEveryMs).toBe((settings.ttlSeconds * 1000) / 4);
    }),
  );
});
