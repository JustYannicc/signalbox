import { describe, expect, it } from "vite-plus/test";
import { runCleanupAlarm } from "../cleanupAlarm.ts";

const fixture = () => {
  let alarm: number | null = null;
  let now = 1_000;
  const storage = {
    setAlarm: async (time: number | Date) => {
      alarm = Number(time);
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  return {
    storage,
    now: () => now,
    alarm: () => alarm,
    afterLateCompletionWindow: () => {
      now = 3_600_002;
    },
  };
};

describe("cleanup alarms", () => {
  it("keeps checking for late allocations after cleanup first reports absence", async () => {
    const f = fixture();
    await runCleanupAlarm(f.storage, async () => ({ deadline: 1, done: true }), f.now);
    expect(f.alarm()).toBe(f.now() + 30_000);
  });

  it("survives token failures past the cutoff and removes a late snapshot before disarming", async () => {
    const f = fixture();
    f.afterLateCompletionWindow();
    let snapshotPresent = true;
    let tokenAvailable = false;
    let deletionComplete = false;
    const sweep = async () => {
      if (!tokenAvailable) throw new Error("token unavailable");
      if (deletionComplete) snapshotPresent = false;
      return { deadline: 1, done: !snapshotPresent };
    };
    await runCleanupAlarm(f.storage, sweep, f.now);
    expect(snapshotPresent).toBe(true);
    expect(f.alarm()).toBe(f.now() + 30_000);
    tokenAvailable = true;
    await runCleanupAlarm(f.storage, sweep, f.now);
    expect(f.alarm()).toBe(f.now() + 30_000);
    deletionComplete = true;
    await runCleanupAlarm(f.storage, sweep, f.now);
    expect(snapshotPresent).toBe(false);
    expect(f.alarm()).toBeNull();
  });

  it("disarms when the sweep confirms there is no stored run", async () => {
    const f = fixture();
    await runCleanupAlarm(f.storage, async () => null, f.now);
    expect(f.alarm()).toBeNull();
  });
});
