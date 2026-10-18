import { selectNodeGitRoute } from "./node/git/routing.ts";
import { runNodeGitHttpCommand } from "./node/git/transport.ts";
import type { NodeGitProgramOptions } from "./node/git/types.ts";
import type {
  KernelAsyncProgram,
  KernelAsyncProgramContext,
} from "../kernel/KernelAsyncProgram.ts";

export type { NodeGitProgramOptions, NodeGitRoute } from "./node/git/types.ts";
export { selectNodeGitRoute } from "./node/git/routing.ts";

/** Composes the HTTP subset with the existing local Git implementation. */
export function createNodeGitProgram(options: NodeGitProgramOptions): KernelAsyncProgram {
  return Object.freeze({
    run: async (context: KernelAsyncProgramContext) => {
      context.signal.throwIfAborted();
      const route = selectNodeGitRoute(context.args);
      if (route.kind === "local") return options.local.run(context);
      if (route.kind === "reject") {
        return runNodeGitHttpCommand.fail(context, route.exitCode, route.message);
      }
      return runNodeGitHttpCommand.run(route, context, options);
    },
  });
}

export type { KernelAsyncProgram };
