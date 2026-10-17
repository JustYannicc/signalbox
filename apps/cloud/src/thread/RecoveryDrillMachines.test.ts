import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { RecoveryEvidence } from "./RecoveryEvidence.ts";
import { active, command, expected, fixture } from "./RecoveryDrillMachines.testSupport.ts";

const invalidTargets: ReadonlyArray<{
  readonly evidence: RecoveryEvidence;
  readonly expected: typeof expected;
  readonly error: string;
}> = [
  {
    evidence: { ...active, activeRunId: null },
    expected: { ...expected, runId: null },
    error: "no_active_run",
  },
  {
    evidence: { ...active, machine: { ...active.machine, machineId: null } },
    expected: { ...expected, machineId: null },
    error: "not_boat_machine",
  },
  {
    evidence: { ...active, lease: { ...active.lease, machineClass: "light" } },
    expected,
    error: "not_boat_machine",
  },
  {
    evidence: { ...active, machine: { ...active.machine, desired: "stopped" } },
    expected,
    error: "stale_target",
  },
];

describe("preview recovery Boat kill", () => {
  it.each(invalidTargets)(
    "rejects a target that is not a current running Boat lease: $error",
    async ({ evidence, expected: target, error }) => {
      const test = fixture(evidence);
      await test.drill().command("owner", command("enroll"));
      expect(
        await test.drill().command("owner", { ...command("kill-machine"), expected: target }),
      ).toEqual({ error });
      expect(test.removeCalls).toBe(0);
      expect(test.state?.faults).toEqual([]);
    },
  );

  it("kills a running Boat VM whose stop is unsettled and leaves its machine record stale", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    const result = await test.drill().command("owner", command("kill-machine"));
    expect(result).toMatchObject({ machineOutcome: "accepted" });
    expect(test.removeCalls).toBe(1);
    expect(test.removed).toEqual(["bx_old"]);
    expect(test.providerCallsInsideExclusive).toBe(0);
    expect(test.state?.faults[0]).toMatchObject({
      action: "kill-machine",
      before: active,
      machineOutcome: "accepted",
      complete: false,
    });
    expect(test.evidence).toMatchObject({ machine: { machineId: "bx_old" } });
    expect(await test.drill().command("owner", command("inspect"))).toMatchObject({
      evidence: { machine: { machineId: "bx_old" } },
    });
  });

  it.each([
    { ...expected, generation: expected.generation + 1 },
    { ...expected, runId: RunId.make("another-run") },
    { ...expected, machineId: "bx_new" },
  ])("rejects a stale target tuple before reserving a fault: %j", async (target) => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    expect(
      await test.drill().command("owner", { ...command("kill-machine"), expected: target }),
    ).toEqual({ error: "stale_target" });
    expect(
      await test.drill().command("owner", {
        ...command("kill-machine", "arbitrary"),
        machineId: "bx_new",
      }),
    ).toEqual({ error: "invalid_command" });
    expect(test.removeCalls).toBe(0);
    expect(test.state?.faults).toEqual([]);
  });

  it("does not repeat a completed or ambiguous DELETE when a reconstructed operator replays its fault ID", async () => {
    const accepted = fixture();
    await accepted.drill().command("owner", command("enroll"));
    await accepted.drill().command("owner", command("kill-machine"));
    expect(await accepted.drill().command("owner", command("kill-machine"))).toMatchObject({
      replayed: true,
      state: { faults: [{ machineOutcome: "accepted" }] },
    });
    expect(accepted.removeCalls).toBe(1);

    const uncertain = fixture();
    uncertain.setDeleteFailure({
      _tag: "BoatApiError",
      status: 0,
      message: "private response text",
    });
    await uncertain.drill().command("owner", command("enroll"));
    const failed = await uncertain.drill().command("owner", command("kill-machine"));
    expect(failed).toMatchObject({ error: "provider_outcome_unknown", providerStatus: 0 });
    expect(JSON.stringify(failed)).not.toContain("private response text");
    expect(await uncertain.drill().command("owner", command("kill-machine"))).toMatchObject({
      replayed: true,
      state: { faults: [{ machineOutcome: "unknown", complete: false }] },
    });
    expect(uncertain.removeCalls).toBe(1);
  });

  it("cancels a reserved kill if the validated tuple changes before the provider call", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    test.setAfterNextExclusive(async () => {
      test.setEvidence({ ...active, lease: { ...active.lease, generation: 6 } });
    });
    expect(await test.drill().command("owner", command("kill-machine"))).toEqual({
      error: "stale_target",
    });
    expect(test.removeCalls).toBe(0);
    expect(test.state?.faults[0]).toMatchObject({
      machineOutcome: "cancelled",
      cancelled: "stale_target",
      complete: true,
    });
  });

  it("lets disable cancel a reserved kill before DELETE starts", async () => {
    const test = fixture();
    const drill = test.drill();
    await drill.command("owner", command("enroll"));
    test.setAfterNextExclusive(async () => {
      await drill.command("owner", command("disable"));
    });
    expect(await drill.command("owner", command("kill-machine"))).toEqual({ error: "disabled" });
    expect(test.removeCalls).toBe(0);
    expect(test.state).toMatchObject({
      enabled: false,
      faults: [{ machineOutcome: "cancelled", cancelled: "disabled", complete: true }],
    });
  });

  it("treats Boat DELETE 404 as an already-absent machine", async () => {
    const test = fixture();
    test.setDeleteFailure({ _tag: "BoatApiError", status: 404, message: "gone" });
    await test.drill().command("owner", command("enroll"));
    expect(await test.drill().command("owner", command("kill-machine"))).toMatchObject({
      error: "machine_absent",
      machineOutcome: "absent",
      state: { faults: [{ complete: true, machineOutcome: "absent" }] },
    });
    expect(test.removed).toEqual(["bx_old"]);
  });
  it("abandons an uncertain fault on disable without repeating its consumed DELETE", async () => {
    const test = fixture();
    const drill = test.drill();
    test.setDeleteFailure({ status: 0 });
    await drill.command("owner", command("enroll"));
    await drill.command("owner", command("kill-machine"));
    expect(
      await drill.command("owner", { ...command("inspect-machine"), machineId: "bx_old" }),
    ).toMatchObject({ machine: { exists: true } });
    await drill.command("owner", command("disable"));
    expect(test.state?.faults[0]).toMatchObject({
      machineOutcome: "unknown",
      complete: true,
      cancelled: "disabled",
    });
    await drill.command("owner", command("enroll"));
    expect(await drill.command("owner", command("kill-machine"))).toMatchObject({ replayed: true });
    expect(await drill.command("owner", command("reset", "next-fault"))).toMatchObject({
      state: { faults: [{ id: "fault-1" }, { id: "next-fault", complete: true }] },
    });
    expect(test.removeCalls).toBe(1);
  });

  it("keeps confirmed absence when DELETE responds after a provider readback", async () => {
    const test = fixture();
    const drill = test.drill();
    await drill.command("owner", command("enroll"));
    test.setBeforeDeleteResponse(async () => {
      expect(
        await drill.command("owner", { ...command("inspect-machine"), machineId: "bx_old" }),
      ).toMatchObject({ machine: { exists: false } });
    });
    expect(await drill.command("owner", command("kill-machine"))).toMatchObject({
      machineOutcome: "absent",
      state: { faults: [{ machineOutcome: "absent", complete: true }] },
    });
    expect(await drill.command("owner", command("reset", "next-fault"))).toMatchObject({
      state: { faults: [{ id: "fault-1" }, { id: "next-fault", complete: true }] },
    });
    expect(test.removeCalls).toBe(1);
  });

  it("keeps an in-flight fault abandoned when disable wins the DELETE response race", async () => {
    const test = fixture();
    const drill = test.drill();
    await drill.command("owner", command("enroll"));
    test.setBeforeDeleteResponse(async () => {
      await drill.command("owner", command("disable"));
    });
    expect(await drill.command("owner", command("kill-machine"))).toMatchObject({
      machineOutcome: "unknown",
      state: { enabled: false, faults: [{ complete: true, cancelled: "disabled" }] },
    });
    await drill.command("owner", command("enroll"));
    expect(await drill.command("owner", command("kill-machine"))).toMatchObject({ replayed: true });
    expect(test.removeCalls).toBe(1);
  });
});
