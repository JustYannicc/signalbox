import { machineEnsureJson } from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { MachineRequest } from "../MachineBackend.ts";
import { makeCloudflareMachineBackend, RUNNER_PORT } from "./CloudflareMachineBackend.ts";

const threadId = ThreadId.make("thread-light");
const request = (generation: number, machineClass: MachineRequest["machineClass"] = "light") => ({
  threadId,
  generation,
  token: `token-${generation}`,
  machineClass,
});

/**
 * `ctx.container` as the backend uses it. `refusals` is how many times the
 * Runner host is not listening yet after a start; `crash` exits the container
 * on its own.
 */
const makeFakeContainer = (refusals = 0) => {
  let exit: { resolve: () => void; reject: (cause: unknown) => void } | null = null;
  let refusing = 0;
  const log: Array<string> = [];
  const handedOver: Array<unknown> = [];
  const container = {
    running: false,
    start(options?: ContainerStartupOptions) {
      if (container.running) throw new Error("already running");
      container.running = true;
      refusing = refusals;
      log.push(`start ${options?.entrypoint?.join(" ")}`);
    },
    monitor: () =>
      new Promise<void>((resolve, reject) => {
        exit = { resolve, reject };
      }),
    async destroy() {
      log.push("destroy");
      container.running = false;
      exit?.resolve();
    },
    async setInactivityTimeout(ms: number) {
      log.push(`timeout ${ms}`);
    },
    getTcpPort(port: number) {
      return {
        fetch: async (_url: string, init: RequestInit) => {
          if (refusing > 0) {
            refusing -= 1;
            throw new Error("connection refused");
          }
          handedOver.push({ port, ...machineEnsureJson.decode(String(init.body)) });
          return new Response(JSON.stringify({ outcome: "started" }));
        },
      };
    },
  };
  const crash = (exitCode: number) => {
    container.running = false;
    exit?.reject(Object.assign(new Error("exited"), { exitCode }));
  };
  return { container: container as unknown as Container, log, handedOver, crash };
};

const settings = { cloudUrl: "https://app.signalbox.run", modelGatewayUrl: "https://gw.example" };

describe("CloudflareMachineBackend", () => {
  it.effect(
    "starts the thread's container as a light Runner host and hands it each generation",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeContainer(2);
        const backend = makeCloudflareMachineBackend({ ...fake, settings, onExit: () => {} });

        expect(yield* backend.ensure(request(1))).toMatchObject({
          actual: "running",
          wake: "cold",
          machineId: `cloudflare:${threadId}`,
        });
        expect(fake.log).toEqual([
          `start node /opt/signalbox/runner.mjs --cloud https://app.signalbox.run --port ${RUNNER_PORT} --listen 0.0.0.0 --home /home/node/signalbox --machine-id cloudflare:${threadId}`,
          "timeout 600000",
        ]);
        // A later generation goes to the same container.
        expect(yield* backend.ensure(request(2))).toMatchObject({
          actual: "running",
          wake: "warm",
        });
        expect(fake.handedOver).toEqual([
          {
            port: RUNNER_PORT,
            threadId,
            generation: 1,
            token: "token-1",
            modelGatewayUrl: "https://gw.example",
            machineClass: "light",
          },
          {
            port: RUNNER_PORT,
            threadId,
            generation: 2,
            token: "token-2",
            modelGatewayUrl: "https://gw.example",
            machineClass: "light",
          },
        ]);
        expect(fake.log).toHaveLength(2);
      }),
  );

  it.effect("hands the same container another class's generation, and stops cheaply", () =>
    Effect.gen(function* () {
      const fake = makeFakeContainer();
      const backend = makeCloudflareMachineBackend({ ...fake, settings, onExit: () => {} });
      yield* backend.ensure(request(1));
      yield* backend.ensure(request(2, "heavy"));
      expect(fake.log.filter((line) => line.startsWith("start"))).toHaveLength(1);
      expect(fake.handedOver.at(-1)).toMatchObject({ generation: 2, machineClass: "heavy" });
      expect((yield* backend.stop(threadId)).actual).toBe("stopped");
      expect((yield* backend.stop(threadId)).actual).toBe("none");
      expect(fake.log.filter((line) => line === "destroy")).toHaveLength(1);
      expect((yield* backend.inspect(threadId)).actual).toBe("none");
    }),
  );

  it.effect("reports an exit it did not ask for, and only that", () =>
    Effect.gen(function* () {
      const fake = makeFakeContainer();
      const exits: Array<string> = [];
      const backend = makeCloudflareMachineBackend({
        ...fake,
        settings,
        onExit: (detail, generation) => void exits.push(`${generation}: ${detail}`),
      });
      yield* backend.ensure(request(1));
      yield* backend.stop(threadId);
      yield* backend.ensure(request(2));
      fake.crash(137);
      yield* Effect.promise(() => Promise.resolve());
      expect(exits).toEqual(["2: The machine ran out of memory (exit 137)."]);
    }),
  );
});
