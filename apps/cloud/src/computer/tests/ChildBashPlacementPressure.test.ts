import { describe, expect, it, vi } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import type { ProcessSlotPressure, ProcessSlotRequest } from "../ProcessSlots.ts";
import { exited } from "./ChildBashFixture.ts";
import {
  bashArtifactAvailable,
  createBashGateway,
  runBashScript,
} from "./ChildBashGatewayFixture.ts";
import { captureText, within } from "./ChildBashGatewayCommand.ts";
import { bashAtomicityWriters as writers } from "./ChildBashAtomicityCases.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const bashArgs = (script: string) => ["bash", "--noprofile", "--norc", "-c", script];
type Unplaceable = Extract<ProcessSlotPressure, { kind: "unplaceable" }>;

async function replayCapturedContinuation(captured: ProcessSlotRequest) {
  const capacity = new ChildWorkerCapacity(4, { owner: "test/bash-captured-continuation" });
  const controller = new AbortController();
  const cancelled = new Error("Placement replay finished");
  const pressured = Promise.withResolvers<Unplaceable>();
  const unsubscribe = capacity.onPressure((pressure) => {
    if (pressure.kind === "unplaceable") pressured.resolve(pressure);
  });
  const execute = vi.fn(async () => {});
  const pending = capacity
    .acquire(
      controller.signal,
      undefined,
      Object.freeze({ codeId: captured.codeId, residentBytes: captured.residentBytes }),
    )
    .then(async (permit) => {
      try {
        await execute();
      } finally {
        await permit.release();
      }
    });
  const settled = pending.then(
    () => ({ kind: "completed" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  try {
    expect(capacity.residentByteLimit).toBe(104 * 1024 * 1024);
    const result = await within(pressured.promise, 15_000);
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("Missing captured-continuation pressure");
    expect(result.value).toMatchObject({
      kind: "unplaceable",
      inFlight: 0,
      resident: 0,
      waiting: 1,
      request: { codeId: captured.codeId, residentBytes: 134_873_088 },
    });
    expect(capacity.active).toBe(0);
    expect(capacity.waiting).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    controller.abort(cancelled);
    expect(await settled).toEqual({ kind: "rejected", error: cancelled });
    expect(capacity.active).toBe(0);
    expect(capacity.waiting).toBe(0);
    expect(capacity.failure).toBeUndefined();
  } finally {
    unsubscribe();
    controller.abort(cancelled);
    await settled;
  }
}

describe.skipIf(!bashArtifactAvailable)("Bash continuation placement pressure", () => {
  it.each(writers)(
    "$label exposes two oversized continuations and replays one placement request",
    async (writer) => {
      const run = createBashGateway();
      const { fixture } = run;
      const controller = new AbortController();
      const pressured = Promise.withResolvers<Unplaceable>();
      const requests = new Set<ProcessSlotRequest>();
      const unsubscribe = fixture.capacity.onPressure((pressure) => {
        if (pressure.kind !== "unplaceable" || !("request" in pressure)) return;
        requests.add(pressure.request);
        if (requests.size === 2) pressured.resolve(pressure);
      });
      const child = await fixture.gateway.exec(
        {
          executable: "/bin/bash",
          argv: bashArgs(writer.script(16 * 1024 * 1024)),
          cwd: "/workspace",
          env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
        },
        controller.signal,
        undefined,
      );
      const stdout = captureText(child.stdout);
      const stderr = captureText(child.stderr);
      const settled = Promise.allSettled([stdout.settled, stderr.settled, child.exited]);
      try {
        expect(fixture.capacity.residentByteLimit).toBe(104 * 1024 * 1024);
        const result = await within(pressured.promise, 15_000);
        if (result.kind !== "completed")
          throw new Error(`Placement pressure missing: ${result.kind}`);
        expect(result.value).toMatchObject({
          kind: "unplaceable",
          inFlight: 0,
          resident: 0,
          waiting: 2,
        });
        expect(requests.size).toBe(2);
        expect([...requests].map((request) => request.residentBytes)).toEqual([
          134_873_088, 134_873_088,
        ]);
        expect(fixture.capacity.active).toBe(0);
        expect(fixture.capacity.waiting).toBe(2);
        expect(run.activeLoaderIds.size).toBe(0);
        expect(fixture.machineSpawn).not.toHaveBeenCalled();
        expect(`${stdout.text()}${stderr.text()}`).not.toMatch(
          /exceededMemory|memory limit|unplaceable|quota/i,
        );

        // Replay exactly one real continuation request at the placement seam, before guest execution.
        await replayCapturedContinuation([...requests][0]!);
        controller.abort();
        await settled;
        await child.dispose();
        await fixture.gateway.drain();
        expect(fixture.capacity.active).toBe(0);
        expect(fixture.capacity.waiting).toBe(0);
        expect(fixture.capacity.failure).toBeUndefined();
        expect(run.activeLoaderIds.size).toBe(0);
        expect(`${stdout.text()}${stderr.text()}`).not.toMatch(
          /exceededMemory|memory limit|unplaceable|quota/i,
        );
        expect(await runBashScript(fixture, "echo after-placement")).toEqual({
          stdout: "after-placement\n",
          stderr: "",
          status: exited(),
        });
      } finally {
        unsubscribe();
        controller.abort();
        await settled;
        await child.dispose();
        await fixture.close();
      }
    },
    45_000,
  );
});
