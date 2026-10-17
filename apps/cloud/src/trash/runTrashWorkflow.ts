import type { TrashProgress } from "./TrashWorkflow.ts";
import { RETRY_MS } from "./trashTables.ts";

interface TrashStep {
  readonly do: <A>(name: string, operation: () => Promise<A>) => Promise<A>;
  readonly sleepUntil: (name: string, at: Date) => Promise<void>;
}

/** Each retry is a journaled step. Resource receipts make replay after a lost reply harmless. */
export async function runTrashWorkflow(step: TrashStep, progress: () => Promise<TrashProgress>) {
  for (let attempt = 0; ; attempt++) {
    const result = await step.do(`cascade-${attempt}`, async () => {
      try {
        return await progress();
      } catch {
        return { done: false, nextAt: Date.now() + RETRY_MS };
      }
    });
    if (result.done) return;
    await step.sleepUntil(`wait-${attempt}`, new Date(result.nextAt));
  }
}
