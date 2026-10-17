import { KeybindingRule, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  matchesKeybindingShortcut,
} from "./keybindings.ts";

const encodeResolved = Schema.encodeSync(ResolvedKeybindingsConfig);
const decodeResolved = Schema.decodeUnknownSync(ResolvedKeybindingsConfig);
const decodeRule = Schema.decodeUnknownSync(KeybindingRule);

// What the server sends and every client decodes: resolved keybindings over JSON.
const overTheWire = (config: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig =>
  decodeResolved(JSON.parse(JSON.stringify(encodeResolved(config))));

const spaceChord = {
  key: " ",
  code: "Space",
  metaKey: true,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
};

describe("resolved keybindings on the wire", () => {
  it("keep a space chord's literal key, so it still matches after decoding", () => {
    const [compiled] = compileResolvedKeybindingsConfig([
      { key: "mod+shift+space", command: "capture.open" },
    ]);
    expect(compiled?.shortcut.key).toBe(" ");

    const [decoded] = overTheWire([compiled!]);
    expect(decoded?.shortcut.key).toBe(" ");
    expect(matchesKeybindingShortcut(spaceChord, decoded!.shortcut, "MacIntel")).toBe(true);
  });

  it("round-trip the defaults unchanged", () => {
    expect(overTheWire([...DEFAULT_RESOLVED_KEYBINDINGS])).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
  });

  it("still trim the chord text people write in a rule", () => {
    expect(decodeRule({ key: "  mod+j  ", command: "terminal.toggle" }).key).toBe("mod+j");
  });
});
