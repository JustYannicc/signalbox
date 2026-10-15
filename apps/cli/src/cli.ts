import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Stdio from "effect/Stdio";
import type * as Terminal from "effect/Terminal";
import { Command } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import { loginCommand, logoutCommand, poolsUseCommand } from "./accountCommands.ts";
import { operationCommands } from "./operationCommands.ts";

/**
 * `signalbox`: Signalbox from a terminal, a script or an agent's shell. Every
 * public API operation is a command (`operationCommands.ts`); `login`,
 * `logout` and `pools use` are the only ones written by hand.
 */
/** What every command may need from the platform. */
type CliServices =
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio
  | Terminal.Terminal
  | ChildProcessSpawner.ChildProcessSpawner;

// The generated tree is typed as `Command.Any`; its failures are all rendered as messages.
export const cli: Command.Command<"signalbox", {}, {}, Error, CliServices> = Command.make(
  "signalbox",
).pipe(
  Command.withDescription("Drive Signalbox from outside the app. Start with `signalbox login`."),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    ...operationCommands([{ path: ["pools", "use"], command: poolsUseCommand }]),
  ]),
) as Command.Command<"signalbox", {}, {}, Error, CliServices>;
