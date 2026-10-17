import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import {
  buildKeybindingRows,
  buildWhenVariableOptions,
  commandLabel,
  filterKeybindingRowsForEnvironment,
  keybindingWhenWithoutTerminal,
} from "./KeybindingsSettings.logic";
import { availableKeybindingWhenVariables } from "./keybindingSettingsCapabilities";

describe("keybinding labels without machine features", () => {
  it("describes the current-folder action while retaining self-hosted wording", () => {
    expect(commandLabel("chat.newLocal", false)).toBe("Chat: New in Current Folder");
    expect(commandLabel("chat.newLocal")).toBe("Chat: New Local");
  });

  it("searches the displayed cloud labels and conditions without changing bindings", () => {
    const all = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    const capabilities = { localFilesystem: false, terminal: false };
    const rows = filterKeybindingRowsForEnvironment(all, "current folder", capabilities);
    expect(rows).toContainEqual(expect.objectContaining({ command: "chat.newLocal" }));
    expect(filterKeybindingRowsForEnvironment(all, "terminalFocus", capabilities)).toEqual([]);
    expect(rows.find((row) => row.command === "chat.newLocal")).toBe(
      all.find((row) => row.command === "chat.newLocal"),
    );
  });

  it("matches upstream's search where every capability is supported", () => {
    const all = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    const supported = { localFilesystem: true, terminal: true };
    for (const query of ["", "terminalFocus", "new local", "mod+"]) {
      expect(filterKeybindingRowsForEnvironment(all, query, supported)).toEqual(
        buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, query),
      );
    }
  });

  it("keeps supported condition choices and the self-hosted options", () => {
    const variables = buildWhenVariableOptions();
    expect(availableKeybindingWhenVariables(variables, true)).toBe(variables);
    expect(availableKeybindingWhenVariables(variables, false)).toContain("isWeb");
    expect(availableKeybindingWhenVariables(variables, false)).not.toEqual(
      expect.arrayContaining(["terminalFocus", "terminalOpen"]),
    );
  });

  it("removes terminal conditions without dropping other requirements", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    const newChat = rows.find((row) => row.command === "chat.new");
    const newPanel = rows.find((row) => row.command === "rightPanel.new");
    expect(keybindingWhenWithoutTerminal(newChat?.binding.whenAst)).toBe("");
    expect(keybindingWhenWithoutTerminal(newPanel?.binding.whenAst)).toBe("rightPanelOpen");
    expect(keybindingWhenWithoutTerminal({ type: "identifier", name: "terminalOpen" })).toBe(
      "Never",
    );
  });
});
