import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { active, command, fixture } from "./RecoveryDrillMachines.testSupport.ts";

describe("preview recovery Boat inspection", () => {
  it("rejects unrecorded IDs before contacting Boat", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    expect(
      await test.drill().command("owner", {
        ...command("inspect-machine"),
        machineId: "bx_foreign",
      }),
    ).toEqual({ error: "unrecorded_machine" });
    expect(test.inspected).toEqual([]);
  });

  it("reads the current VM and recorded old VM after replacement, resolving absence from Boat", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    await test.drill().command("owner", command("kill-machine"));
    test.setEvidence({
      ...active,
      sequence: 15,
      activeRunId: RunId.make("run-2"),
      lease: { ...active.lease, generation: 6 },
      machine: { ...active.machine, machineId: "bx_new" },
    });

    const old = await test.drill().command("owner", {
      ...command("inspect-machine", "read-old"),
      machineId: "bx_old",
    });
    expect(old).toMatchObject({
      checkedSequence: 15,
      machine: { machineId: "bx_old", exists: false, state: null },
      state: { faults: [{ machineOutcome: "absent", complete: true }] },
    });
    const current = await test.drill().command("owner", {
      ...command("inspect-machine", "read-current"),
      machineId: "bx_new",
    });
    expect(current).toMatchObject({
      machine: { machineId: "bx_new", exists: true, state: "provisioning", hydrated: false },
    });
    expect(test.inspected).toEqual(["bx_old", "bx_new"]);
    expect(test.providerCallsInsideExclusive).toBe(0);
  });

  it("sanitizes a live provider inspection failure", async () => {
    const test = fixture();
    test.setInspectFailure({
      _tag: "BoatApiError",
      status: 503,
      message: "private provider details",
    });
    await test.drill().command("owner", command("enroll"));
    const result = await test.drill().command("owner", {
      ...command("inspect-machine", "read-current"),
      machineId: "bx_old",
    });
    expect(result).toEqual({ error: "provider_error", providerStatus: 503 });
    expect(JSON.stringify(result)).not.toContain("private provider details");
  });
});
