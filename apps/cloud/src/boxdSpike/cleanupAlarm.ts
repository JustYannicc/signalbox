import type * as Probe from "./Probe.ts";

export async function runCleanupAlarm(
  storage: Pick<DurableObjectStorage, "setAlarm" | "deleteAlarm">,
  sweep: () => Promise<Pick<Probe.Record, "deadline" | "done"> | null>,
  now: () => number,
) {
  // Token acquisition can fail before the probe saves anything and rearms its alarm.
  await storage.setAlarm(now() + 30_000);
  try {
    const record = await sweep();
    // Only a fresh absence check can end the watch for late provider allocations.
    if (!record || (record.done && now() > record.deadline + 3_600_000)) {
      await storage.deleteAlarm();
    }
  } catch {
    /* The next alarm retries without logging credentials. */
  }
}
