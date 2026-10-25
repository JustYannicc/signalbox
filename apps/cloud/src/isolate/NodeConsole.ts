import { StreamConsole } from "./node/console/Console.ts";
import type { NodeConsoleOptions, NodeConsoleWritable } from "./node/console/options.ts";

export type { NodeConsoleOptions, NodeConsoleWritable } from "./node/console/options.ts";

export interface NodeConsoleConstructor {
  (options: NodeConsoleOptions): StreamConsole;
  (
    stdout: NodeConsoleWritable,
    stderr?: NodeConsoleWritable,
    ignoreErrors?: boolean,
  ): StreamConsole;
  new (options: NodeConsoleOptions): StreamConsole;
  new (
    stdout: NodeConsoleWritable,
    stderr?: NodeConsoleWritable,
    ignoreErrors?: boolean,
  ): StreamConsole;
  readonly prototype: StreamConsole;
}

// Node accepts Console with or without new, including subclasses with overridden methods.
const Console = function Console(
  options: NodeConsoleOptions | NodeConsoleWritable,
  stderr?: NodeConsoleWritable,
  ignoreErrors?: boolean,
) {
  return Reflect.construct(
    StreamConsole,
    [options, stderr, ignoreErrors],
    new.target ?? Console,
  ) as StreamConsole;
} as NodeConsoleConstructor;
Object.defineProperty(Console, "prototype", { value: StreamConsole.prototype });
Object.defineProperty(StreamConsole.prototype, "constructor", {
  value: Console,
  writable: true,
  configurable: true,
});

export function createNodeConsole(
  options: NodeConsoleOptions,
): StreamConsole & { Console: NodeConsoleConstructor };
export function createNodeConsole(
  stdout: NodeConsoleWritable,
  stderr?: NodeConsoleWritable,
): StreamConsole & { Console: NodeConsoleConstructor };
export function createNodeConsole(
  options: NodeConsoleOptions | NodeConsoleWritable,
  stderr?: NodeConsoleWritable,
) {
  return Object.assign(new StreamConsole(options, stderr), { Console });
}
