import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";

import { baseDirFlag } from "../cli/config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import * as T3Import from "./T3Import.ts";

/**
 * `signalbox import-t3`: copies `~/.t3/userdata` into a Signalbox home that
 * has no database yet. The desktop app runs this before it starts the backend
 * when the user accepts its first-launch prompt.
 */
export const importT3Command = Command.make("import-t3", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Copy projects, threads, and settings from T3 Code (~/.t3) into a fresh Signalbox home. T3 Code's data is left unchanged.",
  ),
  Command.withHandler(
    Effect.fn("cli.importT3")(function* (flags) {
      const t3Home = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => t3Home)),
      );
      const paths = yield* T3Import.defaultT3ImportPaths(baseDir);
      yield* Console.log(`Copying T3 Code data from ${paths.sourceStateDir}.`);
      const { copied } = yield* T3Import.importT3Data(paths);
      yield* Console.log(`Imported ${copied.join(", ")} into ${paths.targetStateDir}.`);
    }),
  ),
);
