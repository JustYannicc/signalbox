import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  makeRecoveryDrill,
  type RecoveryDrillEnv,
  type RecoveryDrillState,
} from "./RecoveryDrill.ts";
import { NO_MACHINE_RECORD } from "./runner/MachineBackend.ts";
import { NO_MACHINE } from "./ThreadStore.ts";
import type { RecoveryEvidence } from "./RecoveryEvidence.ts";

const preview = {
  SIGNALBOX_STAGE: "pr-123",
  ENVIRONMENT_ID: "cloud-preview-123",
  RECOVERY_DRILLS: "1",
};
const { token: _token, ...lease } = NO_MACHINE;
const initial: RecoveryEvidence = {
  threadId: ThreadId.make("disposable"),
  sequence: 1,
  activeRunId: null,
  lease,
  machine: NO_MACHINE_RECORD,
  events: [],
  receipts: [],
  sessions: [],
  runs: [],
  reasoning: [],
};
const expected = { generation: 0, runId: null, machineId: null };
const command = (action: string, id = "fault-1") => ({ action, id, commandIds: [], expected });

const fixture = (env: RecoveryDrillEnv = preview) => {
  let state: RecoveryDrillState | undefined;
  let evidence: RecoveryEvidence | null = initial;
  let resets = 0;
  let arms = 0;
  let inspected = 0;
  let incarnations = 0;
  const drill = () =>
    makeRecoveryDrill(env, {
      incarnation: async () => `object-${++incarnations}`,
      load: async () => structuredClone(state),
      save: async (value) => {
        state = structuredClone(value);
      },
      inspect: async () => {
        inspected += 1;
        return evidence;
      },
      reset: () => {
        resets += 1;
        throw new Error("object reset");
      },
      arm: async () => {
        arms += 1;
      },
    });
  return {
    drill,
    get state() {
      return state;
    },
    get resets() {
      return resets;
    },
    get arms() {
      return arms;
    },
    get inspected() {
      return inspected;
    },
    change: (value: RecoveryEvidence | null) => {
      evidence = value;
    },
  };
};

describe("preview recovery drills", () => {
  it.each([
    {},
    { ...preview, SIGNALBOX_STAGE: "production" },
    { ...preview, ENVIRONMENT_ID: "production" },
    { ...preview, RECOVERY_DRILLS: "" },
  ])("cannot operate or inspect a non-enabled preview: %j", async (env) => {
    const test = fixture(env);
    expect(await test.drill().command("owner", command("enroll"))).toEqual({ error: "disabled" });
    expect(test.inspected).toBe(0);
    expect(test.state).toBeUndefined();
  });

  it("requires explicit enrollment of an owned disposable thread", async () => {
    const test = fixture();
    expect(await test.drill().command("owner", command("reset"))).toEqual({
      error: "not_enrolled",
    });
    test.change(null);
    expect(await test.drill().command("owner", command("enroll"))).toEqual({ error: "not_found" });
    expect(test.resets).toBe(0);
  });

  it("persists the pre-fault boundary and one-shot consumption before resetting", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    await expect(test.drill().command("owner", command("reset"))).rejects.toThrow("object reset");
    expect(test.state?.faults[0]).toMatchObject({ id: "fault-1", complete: true, before: initial });
    expect(await test.drill().command("owner", command("reset"))).toMatchObject({ replayed: true });
    expect(test.resets).toBe(1);
    expect(await test.drill().command("owner", command("retry-alarm"))).toEqual({
      error: "id_conflict",
    });
  });

  it.each([
    { ...expected, generation: 1 },
    { ...expected, runId: "another-run" },
    { ...expected, machineId: "another-vm" },
  ])("rejects a changed fault target: %j", async (target) => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    expect(await test.drill().command("owner", { ...command("reset"), expected: target })).toEqual({
      error: "stale_target",
    });
    expect(test.state?.faults).toEqual([]);
    expect(test.resets).toBe(0);
  });

  it("requires a new platform retry after the completed tick, even when the first delivery was already a retry", async () => {
    const test = fixture();
    let ticks = 0;
    const tick = async () => {
      ticks += 1;
    };
    await test.drill().command("owner", command("enroll"));
    await test.drill().command("owner", command("retry-alarm"));
    expect(test.arms).toBe(1);
    await expect(test.drill().alarm({ isRetry: true, retryCount: 2 }, tick)).rejects.toThrow(
      "object reset",
    );
    expect(ticks).toBe(1);
    expect(test.state?.faults[0]).toMatchObject({
      complete: false,
      deliveries: [{ isRetry: true, retryCount: 2 }],
    });
    await test.drill().alarm({ isRetry: true, retryCount: 3 }, tick);
    expect(test.resets).toBe(1);
    expect(test.state?.faults[0]).toMatchObject({
      complete: true,
      deliveries: [
        { isRetry: true, retryCount: 2 },
        { isRetry: true, retryCount: 3 },
      ],
    });
  });

  it("does not label an independent invocation as alarm redelivery", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    await test.drill().command("owner", command("retry-alarm"));
    await expect(
      test.drill().alarm({ isRetry: false, retryCount: 0 }, async () => {}),
    ).rejects.toThrow("object reset");
    await test.drill().alarm({ isRetry: false, retryCount: 0 }, async () => {});
    expect(test.state?.faults[0]).toMatchObject({ complete: true, cancelled: "not_redelivered" });
  });

  it("disabling cancels an armed fault, and re-enrollment does not revive it", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    await test.drill().command("owner", command("retry-alarm"));
    await test.drill().command("owner", command("disable"));
    await test.drill().command("owner", command("enroll"));
    await test.drill().alarm({ isRetry: false, retryCount: 0 }, async () => {});
    expect(test.resets).toBe(0);
    expect(test.state?.faults[0]).toMatchObject({ complete: true, cancelled: "disabled" });
  });
});
