import { describe, expect, it } from "vite-plus/test";
import { createStandardHarnessHookCallback } from "../../src/hooks/StandardHarnessHooks.ts";
import type { HarnessHookRequest } from "../../src/hooks/HarnessHooks.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createStandardProofState } from "./standardProofState.ts";

const stop: HarnessHookRequest = {
  harness: "claude-code",
  event: "stop",
  sessionId: "official-session",
  payload: { hook_event_name: "Stop" },
};
const gateway = { async beforeToolUse() {}, async afterToolUse() {} };

describe("standard hook proof state", () => {
  it("persists one note and settled event and rejects an older generation after reconstruction", async () => {
    const database = createProofTestStorage();
    try {
      const first = createStandardProofState(database.storage, "test");
      const dispatch = createStandardHarnessHookCallback(first.authority, { ...first, gateway });
      const options = { signal: new AbortController().signal };
      await dispatch(stop, options);
      await dispatch(stop, options);
      expect(first.inspect()).toMatchObject({
        ok: true,
        generation: 1,
        taskCompletion: "unchanged",
      });
      const second = createStandardProofState(database.storage, "test");
      expect(second.inspect()).toMatchObject({ ok: false, generation: 2, effects: {} });
      await expect(dispatch(stop, options)).rejects.toThrow("Stale standard proof attempt");
      expect(first.inspect().effects).toMatchObject({
        status: { nextStep: "Check the saved result", progress: "The tool turn finished" },
        "turn-settled": { type: "thread.turn-settled" },
      });
      const resumed = createStandardHarnessHookCallback(second.authority, { ...second, gateway });
      await resumed(stop, options);
      expect(second.inspect().ok).toBe(true);
    } finally {
      database.close();
    }
  });
});
