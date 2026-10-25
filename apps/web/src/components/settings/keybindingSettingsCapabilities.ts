import type { KeybindingCommand, KeybindingWhenNode } from "@t3tools/contracts";

const TERMINAL_VARIABLES = new Set(["terminalFocus", "terminalOpen"]);

export function capabilityKeybindingLabel(command: KeybindingCommand, hasLocalFilesystem: boolean) {
  return command === "chat.newLocal" && !hasLocalFilesystem
    ? "Chat: New in Current Folder"
    : undefined;
}

export function availableKeybindingWhenVariables(
  variables: readonly string[],
  hasTerminal: boolean,
) {
  return hasTerminal
    ? variables
    : variables.filter((variable) => !TERMINAL_VARIABLES.has(variable));
}

/** Only display changes. The stored rule and its identity retain their original conditions. */
export function keybindingWhenWithoutTerminalState(
  value: KeybindingWhenNode,
): KeybindingWhenNode | boolean {
  if (value.type === "identifier") return TERMINAL_VARIABLES.has(value.name) ? false : value;
  if (value.type === "not") {
    const child = keybindingWhenWithoutTerminalState(value.node);
    return typeof child === "boolean" ? !child : { type: "not", node: child };
  }
  const left = keybindingWhenWithoutTerminalState(value.left);
  const right = keybindingWhenWithoutTerminalState(value.right);
  if (typeof left === "boolean") {
    return value.type === "and" ? (left ? right : false) : left ? true : right;
  }
  if (typeof right === "boolean") {
    return value.type === "and" ? (right ? left : false) : right ? true : left;
  }
  return { type: value.type, left, right };
}
