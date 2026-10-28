import { afterEach, expect, it } from "@effect/vitest";
import { HarnessProcessIncarnation } from "../HarnessProcessIncarnation.ts";
import { failTerminalWrite } from "../processResume/tests/terminalWriteFailure.fixture.ts";
import { durableRootContext } from "./processIncarnation/durableRootFixture.ts";

const roots: ReturnType<typeof durableRootContext>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.close();
});

it.each([false, true])(
  "targets the terminal transaction after unrelated fenced writes (after=%s)",
  async (after) => {
    const root = durableRootContext("shard");
    roots.push(root);
    const storage = root.storage as unknown as DurableObjectStorage;
    const incarnation = new HarnessProcessIncarnation(storage, "shard", "nonce");
    await incarnation.ready;
    const guarded = incarnation.storage();
    failTerminalWrite(storage, after);

    await guarded.put("harness-process-completion/v1/run/op/request", { phase: "committed" });
    expect(await storage.get("harness-process-completion/v1/run/op/request")).toEqual({
      phase: "committed",
    });
    const key = "harness-process-terminal/v1/run/op/request";
    await expect(
      guarded.transaction(async (transaction) => {
        await transaction.put(key, { stopped: true });
        await transaction.put("owned-terminal-pointer", key);
      }),
    ).rejects.toThrow(/Injected C evidence/);
    expect(await storage.get(key)).toEqual(after ? { stopped: true } : undefined);
    expect(await storage.get("owned-terminal-pointer")).toBe(after ? key : undefined);
    await guarded.put(key, { stopped: true });
    expect(await storage.get(key)).toEqual({ stopped: true });
  },
);
