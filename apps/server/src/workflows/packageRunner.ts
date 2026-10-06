import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** A package manager command to look for, and the arguments to run it with. */
interface PackageRunnerCandidate {
  readonly name: string;
  /** Look next to the Node automations use instead of on PATH. */
  readonly besideNode?: boolean;
  readonly args: ReadonlyArray<string>;
}

/**
 * The first candidate that exists, in order, as a command and its args.
 * Windows names get `.cmd`; a candidate beside Node is skipped when there's no Node.
 */
export const findPackageRunner = (candidates: ReadonlyArray<PackageRunnerCandidate>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcessPlatform;
    const exe = (name: string) => (platform === "win32" ? `${name}.cmd` : name);
    for (const candidate of candidates) {
      if (candidate.besideNode) {
        const node = yield* resolveNodeExecutable("Automations").pipe(Effect.option);
        if (Option.isNone(node)) continue;
        const beside = path.join(path.dirname(node.value), exe(candidate.name));
        if (yield* fs.exists(beside).pipe(Effect.orElseSucceed(() => false))) {
          return Option.some({ command: beside, args: candidate.args });
        }
        continue;
      }
      const found = yield* resolveCommandPath(exe(candidate.name)).pipe(
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.option,
      );
      if (Option.isSome(found)) return Option.some({ command: found.value, args: candidate.args });
    }
    return Option.none<{ readonly command: string; readonly args: ReadonlyArray<string> }>();
  });
