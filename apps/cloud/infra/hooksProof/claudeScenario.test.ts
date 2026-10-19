import { describe, expect, it } from "@effect/vitest";
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_ROUTES,
  createClaudeHookScenario,
} from "./claudeScenario.ts";

describe("Claude official hook proof settings", () => {
  it("registers command, Signalbox callback and generated script routes for each event", () => {
    const scenario = createClaudeHookScenario();
    expect(scenario.configuredHooks).toHaveLength(
      CLAUDE_HOOK_EVENTS.length * CLAUDE_HOOK_ROUTES.length,
    );
    expect(scenario.registrations.size).toBe(scenario.configuredHooks.length);

    for (const { event, officialName } of CLAUDE_HOOK_EVENTS) {
      const configured = scenario.configuredHooks.filter((hook) => hook.event === event);
      const settings = scenario.settings.hooks[officialName];
      expect(configured).toHaveLength(CLAUDE_HOOK_ROUTES.length);
      expect(settings?.[0]?.hooks).toHaveLength(CLAUDE_HOOK_ROUTES.length);
      for (const { id } of configured) {
        const registration = scenario.registrations.get(id);
        expect(registration?.event).toBe(event);
        expect(settings?.[0]?.hooks).toContainEqual({
          type: "command",
          command: "/usr/bin/signalbox-hook " + id,
        });
      }
    }
  });
});
