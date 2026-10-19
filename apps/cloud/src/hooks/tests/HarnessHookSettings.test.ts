import { parse } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";
import {
  claudeHarnessHookSettings,
  codexHarnessHookRequirements,
  type ConfiguredHarnessHook,
} from "../HarnessHookSettings.ts";

const registrations = [
  { id: "session-start", event: "session-start" },
  { id: "before_command", event: "pre-tool-use" },
  { id: "after-command", event: "post-tool-use" },
  { id: "before-rpc", event: "pre-tool-use" },
  { id: "stop", event: "stop" },
] as const satisfies readonly ConfiguredHarnessHook[];

describe("official harness hook settings", () => {
  it("keeps Claude event groups and ordered handlers in its native settings shape", () => {
    expect(claudeHarnessHookSettings(registrations)).toEqual({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "/usr/bin/signalbox-hook session-start" }] },
        ],
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: "/usr/bin/signalbox-hook before_command" },
              { type: "command", command: "/usr/bin/signalbox-hook before-rpc" },
            ],
          },
        ],
        PostToolUse: [
          { hooks: [{ type: "command", command: "/usr/bin/signalbox-hook after-command" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "/usr/bin/signalbox-hook stop" }] }],
      },
    });
  });

  it("emits parseable Codex managed requirements with enabled hooks and all handlers", () => {
    const requirements = parse(codexHarnessHookRequirements(registrations));
    expect(requirements.features).toEqual({ hooks: true });
    expect(requirements.hooks).toEqual({
      managed_dir: "/usr/bin",
      SessionStart: [
        { hooks: [{ type: "command", command: "/usr/bin/signalbox-hook session-start" }] },
      ],
      PreToolUse: [
        { hooks: [{ type: "command", command: "/usr/bin/signalbox-hook before_command" }] },
        { hooks: [{ type: "command", command: "/usr/bin/signalbox-hook before-rpc" }] },
      ],
      PostToolUse: [
        { hooks: [{ type: "command", command: "/usr/bin/signalbox-hook after-command" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "/usr/bin/signalbox-hook stop" }] }],
    });
  });

  it.each(["", "x; touch /tmp/owned", "$(echo x)", "a\nb", "a'b", "../hook"])(
    "rejects an ID that can change a command or its settings: %j",
    (id) => {
      const invalid = [{ id, event: "stop" }] as const;
      expect(() => claudeHarnessHookSettings(invalid)).toThrow(TypeError);
      expect(() => codexHarnessHookRequirements(invalid)).toThrow(TypeError);
    },
  );
});
