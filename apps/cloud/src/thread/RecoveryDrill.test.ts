import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  makeRecoveryDrill,
  type RecoveryDrillEnv,
  type RecoveryDrillState,
} from "./RecoveryDrill.ts";
import { NO_MACHINE } from "./ThreadStore.ts";
import type { RecoveryEvidence, RecoveryInspection } from "./RecoveryEvidence.ts";

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
  machine: { machineId: null, createKey: null, desired: "stopped", settled: true },
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
  let evidence: RecoveryInspection = initial;
  let resets = 0;
  let arms = 0;
  let inspected = 0;
  let incarnations = 0;
  let armingFails = false;
  const drill = () =>
    makeRecoveryDrill(env, {
      incarnation: async () => `object-${++incarnations}`,
      load: async () => structuredClone(state),
      save: async (value, arm) => {
        if (arm && armingFails) throw new Error("alarm unavailable");
        state = structuredClone(value);
        if (arm) arms += 1;
      },
      reset: () => {
        resets += 1;
        throw new Error("object reset");
      },
      exclusive: (work) =>
        work(async () => {
          inspected += 1;
          return evidence;
        }),
      rearm: async () => {},
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
    failArming: (fails: boolean) => {
      armingFails = fails;
    },
    change: (value: RecoveryInspection) => {
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

  it("does not revive a fault disabled and re-enrolled during the real tick", async () => {
    const test = fixture();
    const drill = test.drill();
    await drill.command("owner", command("enroll"));
    await drill.command("owner", command("retry-alarm"));
    await drill.alarm({ isRetry: false, retryCount: 0 }, async () => {
      await drill.command("owner", command("disable"));
      await drill.command("owner", command("enroll"));
    });
    expect(test.resets).toBe(0);
    expect(test.state?.faults[0]).toMatchObject({
      complete: true,
      cancelled: "disabled",
      deliveries: [],
    });
  });

  it("cancels rather than resetting a target changed by the real tick", async () => {
    const test = fixture();
    const drill = test.drill();
    await drill.command("owner", command("enroll"));
    await drill.command("owner", command("retry-alarm"));
    await drill.alarm({ isRetry: false, retryCount: 0 }, async () => {
      test.change({ ...initial, lease: { ...initial.lease, generation: 1 } });
    });
    expect(test.resets).toBe(0);
    expect(test.state?.faults[0]).toMatchObject({ complete: true, cancelled: "stale_target" });
  });

  it("preserves the platform alarm through reconstruction until its retry completes", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    expect(await test.drill().preservesAlarm()).toBe(false);
    await test.drill().command("owner", command("retry-alarm"));
    expect(await test.drill().preservesAlarm()).toBe(true);
    await expect(
      test.drill().alarm({ isRetry: false, retryCount: 0 }, async () => {
        expect(await test.drill().preservesAlarm()).toBe(true);
      }),
    ).rejects.toThrow("object reset");
    expect(await test.drill().preservesAlarm()).toBe(true);
    await test.drill().alarm({ isRetry: true, retryCount: 1 }, async () => {});
    expect(await test.drill().preservesAlarm()).toBe(false);
  });

  it("rejects over-limit evidence without resetting and still allows disabling", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    await test.drill().command("owner", command("retry-alarm"));
    test.change({ error: "evidence_limit" });
    for (const action of ["inspect", "enroll", "reset"]) {
      expect(await test.drill().command("owner", command(action))).toEqual({
        error: "evidence_limit",
      });
    }
    const inspected = test.inspected;
    expect(await test.drill().command("owner", command("disable"))).toMatchObject({
      state: { enabled: false },
    });
    expect(test.inspected).toBe(inspected);
    expect(test.resets).toBe(0);
  });

  it("cannot leave a pending fault when atomic alarm arming fails", async () => {
    const test = fixture();
    await test.drill().command("owner", command("enroll"));
    test.failArming(true);
    await expect(test.drill().command("owner", command("retry-alarm"))).rejects.toThrow(
      "alarm unavailable",
    );
    expect(test.state?.faults).toEqual([]);
    expect(await test.drill().preservesAlarm()).toBe(false);
    test.failArming(false);
    await test.drill().command("owner", command("retry-alarm"));
    expect(test.arms).toBe(1);
    expect(await test.drill().preservesAlarm()).toBe(true);
    await expect(
      test.drill().alarm({ isRetry: false, retryCount: 0 }, async () => {}),
    ).rejects.toThrow("object reset");
    await test.drill().alarm({ isRetry: true, retryCount: 1 }, async () => {});
    expect(test.state?.faults[0]).toMatchObject({ complete: true });
    expect(await test.drill().preservesAlarm()).toBe(false);
  });
});
