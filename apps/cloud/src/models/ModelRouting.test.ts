import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as ModelRouting from "./ModelRouting.ts";

const instance = (id: string) => ProviderInstanceId.make(id);

describe("ModelRouting public entry point", () => {
  it("maps pool and legacy instances to their harness pool", () => {
    expect(ModelRouting.poolIdOfInstance(instance("claude_hub"))).toBe("personal");
    expect(ModelRouting.poolIdOfInstance(instance("codex_hub_work-2"))).toBe("work-2");
    expect(ModelRouting.poolIdOfInstance(instance("claudeAgent"))).toBe("personal");
    expect(ModelRouting.poolIdOfInstance(instance("codex"))).toBe("personal");
    expect(ModelRouting.poolIdOfInstance(instance("scripted"))).toBeUndefined();
    expect(ModelRouting.poolIdOfInstance(instance("grok_hub_work"))).toBeUndefined();
  });

  it("routes pool instances to a harness and leaves scripted runs in the thread", () => {
    expect(ModelRouting.isHarnessInstance(instance("claude_hub_work"))).toBe(true);
    expect(ModelRouting.poolKindOfInstance(instance("claude_hub_work"))).toBe("claude");
    expect(ModelRouting.gatewayProviderFor(instance("claude_hub_work"))).toBe("anthropic");
    expect(ModelRouting.runnerInstanceFor(instance("claude_hub_work"))).toBe("claudeAgent");
    expect(ModelRouting.driverFor(instance("claude_hub_work"))).toBe(
      ProviderDriverKind.make("claudeAgent"),
    );

    expect(ModelRouting.isHarnessInstance(instance("scripted"))).toBe(false);
    expect(ModelRouting.gatewayProviderFor(instance("scripted"))).toBeUndefined();
    expect(ModelRouting.runnerInstanceFor(instance("scripted"))).toBeUndefined();
    expect(ModelRouting.driverFor(instance("scripted"))).toBe(ProviderDriverKind.make("scripted"));
    expect(ModelRouting.CLOUD_POOL_KINDS).toEqual(["claude", "codex"]);
  });

  it("checks a model against the provider API its pool harness serves", () => {
    const served = [
      { id: "gpt-6-luna", ownedBy: "openai", created: 1 },
      { id: "claude-sonnet-5-5", ownedBy: "anthropic", created: 1 },
    ];

    expect(ModelRouting.servesModel("codex", served, "gpt-6-luna")).toBe(true);
    expect(ModelRouting.servesModel("codex", served, "claude-sonnet-5-5")).toBe(false);
    expect(ModelRouting.servesModel("claude", served, "claude-sonnet-5-5")).toBe(true);
    expect(ModelRouting.servesModel("claude", served, "not-served")).toBe(false);
  });
});
