// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import type * as NodeStream from "node:stream";
import type * as NodeUtil from "node:util";

export type NodeConsoleWritable = Pick<NodeStream.Writable, "write"> &
  Partial<Pick<NodeStream.Writable, "once" | "removeListener" | "listenerCount">> & {
    readonly isTTY?: boolean;
  };
export interface NodeConsoleOptions {
  readonly stdout: NodeConsoleWritable;
  readonly stderr?: NodeConsoleWritable;
  readonly ignoreErrors?: boolean;
  readonly colorMode?: boolean | "auto";
  readonly inspectOptions?:
    | NodeUtil.InspectOptions
    | Map<NodeConsoleWritable, NodeUtil.InspectOptions>;
  readonly groupIndentation?: number;
}

export function consoleOptions(
  input: NodeConsoleOptions | NodeConsoleWritable,
  stderr?: NodeConsoleWritable,
  ignoreErrors?: boolean,
) {
  const options: NodeConsoleOptions =
    "write" in input
      ? {
          stdout: input,
          ...(stderr === undefined ? {} : { stderr }),
          ...(ignoreErrors === undefined ? {} : { ignoreErrors }),
        }
      : input;
  const out = options.stdout;
  const err = options.stderr ?? out;
  for (const [name, stream] of [
    ["stdout", out],
    ["stderr", err],
  ] as const) {
    if (!stream || typeof stream.write !== "function")
      throw new TypeError(`Console expects a writable ${name} stream`);
  }
  const color = options.colorMode ?? "auto";
  if (![true, false, "auto"].includes(color)) throw new TypeError("Invalid console colorMode");
  const indentation = options.groupIndentation ?? 2;
  if (!Number.isInteger(indentation) || indentation < 0 || indentation > 1000)
    throw new RangeError("Console groupIndentation must be an integer between 0 and 1000");
  const supplied = options.inspectOptions;
  if (supplied !== undefined && (supplied === null || typeof supplied !== "object"))
    throw new TypeError("Console inspectOptions must be an object");
  const inspectFor = (stream: NodeConsoleWritable): NodeUtil.InspectOptions => {
    const value = supplied instanceof Map ? supplied.get(stream) : supplied;
    return { colors: color === "auto" ? stream.isTTY === true : color, ...value };
  };
  const inspectValues = supplied instanceof Map ? [...supplied.values()] : [supplied];
  if (options.colorMode !== undefined && inspectValues.some((value) => value?.colors !== undefined))
    throw new TypeError("Console inspectOptions.colors and colorMode cannot be combined");
  return { out, err, indentation, ignoreErrors: options.ignoreErrors ?? true, inspectFor };
}
