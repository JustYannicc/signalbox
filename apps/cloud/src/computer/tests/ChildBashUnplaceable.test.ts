import { describe, expect, it, vi } from "vite-plus/test";
import type { ProcessSlotPressure } from "../ProcessSlots.ts";
import { readAll } from "../commandGatewayTesting.ts";
import { bashArtifactAvailable, createBashGateway } from "./ChildBashGatewayFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe.skipIf(!bashArtifactAvailable)("Bash placement pressure through CommandGateway", () => {
  it("stops the old invocation and reports an oversized continuation as unplaceable", async () => {
    const run = createBashGateway();
    const pressure = Promise.withResolvers<ProcessSlotPressure>();
    const unsubscribe = run.fixture.capacity.onPressure((value) => {
      if (value.kind === "unplaceable") pressure.resolve(value);
    });
    let child;
    try {
      child = await run.fixture.gateway.exec(
        {
          executable: "/bin/bash",
          argv: [
            "bash",
            "--noprofile",
            "--norc",
            "-c",
            "printf -v x '%*s' 50000000 ''; printf '%s\\n' \"${#x}\"",
          ],
          cwd: "/workspace",
          env: { HOME: "/workspace", PATH: "/bin" },
        },
        run.fixture.controller.signal,
        undefined,
      );
      const output = Promise.allSettled([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      const observed = await pressure.promise;
      expect(observed.kind).toBe("unplaceable");
      if (!("request" in observed)) throw new Error("Missing unplaceable request");
      expect(observed.request.residentBytes).toBeGreaterThan(
        run.fixture.capacity.residentByteLimit,
      );
      expect(run.activeLoaderIds.size).toBe(0);
      expect(run.fixture.capacity.active).toBe(0);
      expect(run.fixture.capacity.waiting).toBe(1);
      expect(run.workerRuns).toBe(1);
      expect(run.fixture.machineSpawn).not.toHaveBeenCalled();
      run.fixture.controller.abort(new Error("Unplaceable placement proof finished"));
      const results = await output;
      const stderr = results[1];
      if (stderr?.status === "fulfilled") {
        expect(new TextDecoder().decode(stderr.value)).not.toMatch(/exceededMemory|memory limit/i);
      }
      expect(run.fixture.capacity.waiting).toBe(0);
      expect(run.fixture.capacity.failure).toBeUndefined();
    } finally {
      unsubscribe();
      run.fixture.controller.abort(new Error("Unplaceable placement proof cleanup"));
      // Cancellation is observable through the command and drain paths.
      await Promise.allSettled([child?.dispose(), run.fixture.close()]);
      expect(run.activeLoaderIds.size).toBe(0);
      expect(run.fixture.capacity.active).toBe(0);
      expect(run.fixture.capacity.waiting).toBe(0);
    }
  });
});
