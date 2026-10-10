import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { poolIdOfInstance } from "./providerCatalog.ts";

describe("poolIdOfInstance", () => {
  it("names the pool a harness turn runs on", () => {
    const poolOf = (id: string) => poolIdOfInstance(ProviderInstanceId.make(id));
    expect(poolOf("claude_hub")).toBe("personal");
    expect(poolOf("codex_hub_work-2")).toBe("work-2");
    // Threads from before pools ran on the plain instances, now Personal's.
    expect(poolOf("claudeAgent")).toBe("personal");
    expect(poolOf("codex")).toBe("personal");
    // Not a harness: the scripted provider, and kinds the cloud can't run.
    expect(poolOf("scripted")).toBeUndefined();
    expect(poolOf("grok_hub_work")).toBeUndefined();
  });
});
