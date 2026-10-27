import { describe, expect, it, vi } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture } from "./ChildBashFixture.ts";
import { bashModule, machinePathFixture } from "./MachinePathFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("the process residency setting", () => {
  it.each(["120000000", String(104 * 1024 * 1024), "123456789"])(
    "uses the supplied RESIDENT_BYTE_LIMIT %s for the admitted execution",
    async (RESIDENT_BYTE_LIMIT) => {
      const capacity = new ChildWorkerCapacity(1, {
        owner: "test/residency-setting",
        RESIDENT_BYTE_LIMIT,
      });
      expect(capacity.residentByteLimit).toBe(Number(RESIDENT_BYTE_LIMIT));
      const permit = await capacity.acquire(new AbortController().signal, undefined);
      try {
        expect(permit.execution.residentByteLimit).toBe(Number(RESIDENT_BYTE_LIMIT));
      } finally {
        await permit.release();
      }
    },
  );

  it.each(["", " ", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
    "rejects an invalid RESIDENT_BYTE_LIMIT %j",
    (RESIDENT_BYTE_LIMIT) => {
      expect(
        () =>
          new ChildWorkerCapacity(1, {
            owner: "test/invalid-residency-setting",
            RESIDENT_BYTE_LIMIT,
          }),
      ).toThrow(RangeError);
    },
  );

  it("rejects an omitted product setting", () => {
    // @ts-expect-error The JavaScript caller deliberately omits the required product setting.
    expect(() => new ChildWorkerCapacity(1, { owner: "test/missing-residency-setting" })).toThrow(
      RangeError,
    );
  });

  it("requires a valid derived limit before constructing a child reactor", async () => {
    const fixture = childBashFixture();
    const options = {
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: fixture.owner.port,
      args: fixture.context.args,
      env: fixture.context.env,
    };
    try {
      // @ts-expect-error No child-local default may replace missing admitted metadata.
      expect(() => createChildBash(options)).toThrow(RangeError);
      for (const residentByteLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => createChildBash({ ...options, residentByteLimit })).toThrow(RangeError);
      }
    } finally {
      await fixture.close();
    }
  });

  it.skipIf(bashModule === undefined)(
    "runs an explicitly configured product consumer above the qualification-only limit",
    async () => {
      const environment = { RESIDENT_BYTE_LIMIT: "123456789" };
      const fixture = machinePathFixture(bashModule!, environment);
      const unplaceable = Promise.withResolvers<never>();
      const stopPressure = fixture.capacity.onPressure((pressure) => {
        if (pressure.kind === "unplaceable")
          unplaceable.reject(
            new Error(`Configured product was unplaceable: ${JSON.stringify(pressure)}`),
          );
      });
      try {
        const result = await Promise.race([
          fixture.run("printf -v x '%*s' 48000000 ''; printf '%s\\n' \"${#x}\""),
          unplaceable.promise,
        ]);
        expect(result.status).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
        expect(result.stdout).toBe("48000000\n");
        expect(result.stderr).toBe("");
        expect(fixture.capacity.residentByteLimit).toBe(Number(environment.RESIDENT_BYTE_LIMIT));
        expect(
          fixture.bashWorkerCalls.every(
            (call) => call.residentByteLimit === Number(environment.RESIDENT_BYTE_LIMIT),
          ),
        ).toBe(true);
        const peak = Math.max(...fixture.bashWorkerCalls.map((call) => call.peakResidentWasmBytes));
        expect(peak).toBeGreaterThan(104 * 1024 * 1024);
        expect(peak).toBeLessThanOrEqual(Number(environment.RESIDENT_BYTE_LIMIT));
        expect(fixture.capacity.active).toBe(0);
        expect(fixture.machineCalls).toEqual([]);
      } finally {
        stopPressure();
        await fixture.close();
      }
    },
  );
});
