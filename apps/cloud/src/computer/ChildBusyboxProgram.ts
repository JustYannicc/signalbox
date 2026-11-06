import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import {
  createChildWorkerProgram,
  type ChildWorkerDispatch,
  type ChildWorkerInvocation,
  type ChildWorkerProgramOptions,
} from "./ChildWorkerProgram.ts";
import { createWorkerBusyboxHost } from "./WorkerBusyboxHost.ts";

export type ChildBusyboxProgramOptions = Omit<
  ChildWorkerProgramOptions<KernelBusyboxPort>,
  "createHost"
>;

/** Source modules and WASM bytes pass straight to the existing shared child admission path. */
export function createChildBusyboxProgram(options: ChildBusyboxProgramOptions) {
  const dispatch = adaptChildArguments(options.executable, options.dispatch);
  const childEnv: ChildBusyboxProgramOptions["childEnv"] =
    options.executable === "/bin/grep"
      ? (context) => ({
          ...(options.childEnv?.(context) ?? context.env),
          PWD: context.filesystem.cwd,
        })
      : options.childEnv;
  return createChildWorkerProgram({
    ...options,
    dispatch,
    ...(childEnv === undefined ? {} : { childEnv }),
    createHost: (context, lease) => {
      const args = childArguments(options.executable, context.args);
      const childContext = args === context.args ? context : { ...context, args };
      return createWorkerBusyboxHost(
        {
          context: childContext,
          ...(options.executable === "/bin/grep" ? { relativePathsFromCwd: true } : {}),
        },
        lease,
      );
    },
  });
}

function adaptChildArguments(
  executable: string,
  dispatch: ChildWorkerDispatch<KernelBusyboxPort>,
): ChildWorkerDispatch<KernelBusyboxPort> {
  return {
    run(input, host, onMemoryLost) {
      const args = childArguments(executable, input.command.argv);
      const adapted: ChildWorkerInvocation =
        args === input.command.argv
          ? input
          : { ...input, command: { ...input.command, argv: args } };
      return dispatch.run(adapted, host, onMemoryLost);
    },
  };
}

function childArguments(executable: string, argv: readonly string[]) {
  let args = argv;
  if (executable === "/bin/grep") {
    args = grepArguments(argv);
  }
  if (executable === "/bin/sed" && args[1] === "-i" && args[2] === "" && args.length >= 5) {
    args = [...args.slice(0, 2), ...args.slice(3)];
  }
  return args;
}

function grepArguments(argv: readonly string[]) {
  const args = [...argv];
  let options = true;
  let pattern = false;
  let recursive = false;
  const operands: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && (argument === "--include" || argument === "--exclude-dir")) {
      index++;
      continue;
    }
    if (options && (argument.startsWith("--include=") || argument.startsWith("--exclude-dir="))) {
      continue;
    }
    if (options && /^-[GEinvr]+$/.test(argument)) {
      recursive ||= argument.includes("r");
      continue;
    }
    if (!pattern) {
      pattern = true;
      continue;
    }
    operands.push(argument);
  }
  // Ugrep trims the trailing slash from ./, so format this recursive root's output explicitly.
  const rootFormat =
    recursive && operands.length === 1 && operands[0] === "." ? ["--format=./%F%N%O%~"] : [];
  return [args[0]!, "--jobs=1", ...rootFormat, ...args.slice(1)];
}
