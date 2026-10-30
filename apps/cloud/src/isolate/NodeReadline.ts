import { StreamLineInterface, unsupportedReadline } from "./node/readline/Interface.ts";
import type { ReadlineOptions } from "./node/readline/Interface.ts";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";

export type { ReadlineOptions } from "./node/readline/Interface.ts";

export function createNodeReadline() {
  const createInterface = (
    input: ReadlineOptions | NodeJS.ReadableStream,
    output?: NodeJS.WritableStream,
    completer?: unknown,
    terminal?: boolean,
  ) => new StreamLineInterface(input, output, completer, terminal);
  markNodeBuiltinCapability(createInterface, {
    status: "conditional",
    evidence:
      "NodeReadline.createInterface supports non-terminal stream framing and iteration; terminal mode and completers throw ERR_METHOD_NOT_IMPLEMENTED.",
  });
  const module = {
    Interface: StreamLineInterface,
    createInterface,
    promises: { Interface: StreamLineInterface, createInterface },
    clearLine: (..._args: unknown[]) => unsupportedReadline("clearLine"),
    clearScreenDown: (..._args: unknown[]) => unsupportedReadline("clearScreenDown"),
    cursorTo: (..._args: unknown[]) => unsupportedReadline("cursorTo"),
    moveCursor: (..._args: unknown[]) => unsupportedReadline("moveCursor"),
    emitKeypressEvents: (..._args: unknown[]) => unsupportedReadline("emitKeypressEvents"),
  };
  return Object.assign(module, { default: module });
}
