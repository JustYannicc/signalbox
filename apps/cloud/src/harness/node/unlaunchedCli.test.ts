import { expect, it } from "vite-plus/test";
import { launchNodeHarnessProcess } from "../NodeHarnessProcess.ts";
import { claudeFixture } from "../releaseLoader/tests/artifactFixtures.ts";
import { loadHarnessRelease } from "../HarnessReleaseLoader.ts";
import { fixture } from "./tests/fixture.ts";

it("closes a public CLI process before its first SDK launch without requiring evaluated release code", async () => {
  const f = fixture();
  const artifact = await claudeFixture();
  const loaded = await loadHarnessRelease(artifact.options);
  const plan = loaded.plan;
  if (plan.harness !== "claude-code") throw new Error("Expected the Claude fixture");
  const entered = Promise.withResolvers<void>();
  let launches = 0;
  const process = launchNodeHarnessProcess({
    ...f.input,
    loadedRelease: {
      ...loaded,
      plan: {
        ...plan,
        hostEntrypoints: { "signalbox/runtime-compatibility": "cli/compatibility.js" },
      },
    },
    loadRelease: async (_bridge, signal) => {
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return {
        launch() {
          launches++;
        },
      };
    },
  });
  try {
    await Promise.race([entered.promise, process.exited]);
    await expect(process.dispose()).resolves.toBeUndefined();
    expect(launches).toBe(0);
  } finally {
    await process.dispose().catch(() => undefined);
    await f.close();
  }
});
