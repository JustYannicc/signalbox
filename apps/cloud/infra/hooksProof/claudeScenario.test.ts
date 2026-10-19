import { describe, expect, it } from "@effect/vitest";
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_PROGRAM_FACADE,
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

  it("keeps the registered program manifest in the executable facade source", () => {
    expect(CLAUDE_HOOK_PROGRAM_FACADE).toBe(
      [
        "signalbox-kernel-program-facade",
        "name=signalbox-hook",
        "version=1.0.0",
        "abiVersion=1",
        "entrypoint=signalbox-hook-v1",
        "",
      ].join("\n"),
    );
  });

  it("keeps route handlers nonblocking and generated-script output inert", async () => {
    const scenario = createClaudeHookScenario();
    const command = scenario.registrations.get("claude-stop-command");
    const rpc = scenario.registrations.get("claude-stop-signalbox");
    const script = scenario.registrations.get("claude-stop-script");

    expect(command).toMatchObject({
      kind: "command",
      command: {
        executable: "/bin/bash",
        argv: ["/bin/bash", "-c", "cat >> /work/hook-command-events.jsonl"],
      },
    });
    expect(rpc?.kind).toBe("signalbox");
    if (rpc?.kind !== "signalbox") throw new Error("Missing Signalbox fixture route");
    const response = await rpc.callback(
      {
        harness: "claude-code",
        event: "stop",
        sessionId: "official-session",
        payload: { hook_event_name: "Stop", session_id: "official-session" },
      },
      { signal: new AbortController().signal },
    );
    expect(response).toEqual({ continue: true });
    expect(scenario.rpcCalls[0]?.sessionId).toBe("official-session");
    expect(script).toMatchObject({
      kind: "script",
      program: {
        id: "claude-hook-script-stop",
        mainModule: "hook.js",
      },
    });
    if (script?.kind !== "script") throw new Error("Missing generated script route");
    const generatedSource = script.program.modules["hook.js"];
    expect(generatedSource).toContain("await request.json()");
    expect(generatedSource).toContain('input?.hook_event_name === "Stop"');
    expect(generatedSource).toContain('input?.cwd === "/work"');
    expect(scenario.rpcCalls).toHaveLength(1);
  });
});
