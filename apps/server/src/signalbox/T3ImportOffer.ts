import * as NodeTerminal from "@effect/platform-node/NodeTerminal";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Prompt } from "effect/unstable/cli";

import type { CliServerFlags } from "../cli/config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { checkT3Import, defaultT3ImportPaths, importT3Data } from "./T3Import.ts";

class T3ImportCancelledError extends Schema.TaggedError<T3ImportCancelledError>()(
  "T3ImportCancelledError",
  {},
) {
  override get message(): string {
    return "Startup cancelled.";
  }
}

/** A prompt nobody answers (a detached terminal) must not hold startup forever. */
const PROMPT_TIMEOUT = Duration.minutes(2);

const ServerStartEnvironment = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option),
  mode: Config.String("T3CODE_MODE").pipe(Config.option),
  devUrl: Config.String("VITE_DEV_SERVER_URL").pipe(Config.option),
  bootstrapFd: Config.String("T3CODE_BOOTSTRAP_FD").pipe(Config.option),
});

/**
 * Offers the import when a CLI-started server first runs on the default home.
 * An interactive terminal gets a yes/no prompt (Ctrl+C cancels startup);
 * anything else (services, scripts) gets a log line, because nothing is
 * imported without the user choosing it. The desktop app asks with its own
 * dialog before it starts the backend, which arrives here with a bootstrap fd.
 */
export const offerT3ImportOnServerStart = Effect.fn("T3Import.offerOnServerStart")(function* (
  flags: CliServerFlags,
) {
  const env = yield* ServerStartEnvironment;
  const some = (value: Option.Option<unknown> | undefined) =>
    value !== undefined && Option.isSome(value);
  if (
    some(flags.baseDir) ||
    some(env.t3Home) ||
    some(flags.bootstrapFd) ||
    some(env.bootstrapFd) ||
    some(flags.devUrl) ||
    some(env.devUrl) ||
    Option.getOrUndefined(flags.mode ?? Option.none()) === "desktop" ||
    Option.getOrUndefined(env.mode) === "desktop"
  ) {
    return;
  }
  const paths = yield* defaultT3ImportPaths(yield* resolveBaseDir(undefined));
  const available = yield* checkT3Import(paths).pipe(
    Effect.as(true),
    Effect.catchTag("T3ImportUnavailableError", () => Effect.succeed(false)),
  );
  if (!available) return;

  const hint = `Found T3 Code data in ${paths.sourceStateDir}. Signalbox is starting with an empty home; to copy that data over instead, stop Signalbox, move ${paths.targetStateDir} aside, and run \`signalbox import-t3\`.`;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    yield* Effect.logInfo(hint);
    return;
  }
  const answer = yield* Prompt.run(
    Prompt.Confirm({
      message: `Found T3 Code data in ${paths.sourceStateDir}. Copy your projects, threads, and settings into Signalbox? T3 Code's data stays as it is.`,
      initial: true,
    }),
  ).pipe(
    Effect.catchTag("QuitError", () => Effect.fail(new T3ImportCancelledError())),
    Effect.timeoutOption(PROMPT_TIMEOUT),
    Effect.provide(NodeTerminal.layer),
  );
  if (Option.isNone(answer)) {
    yield* Effect.logInfo(hint);
    return;
  }
  if (!answer.value) return;
  yield* Console.log("Copying T3 Code data. Large histories can take a minute.");
  yield* importT3Data(paths);
  yield* Console.log(`Imported T3 Code data into ${paths.targetStateDir}.`);
});
