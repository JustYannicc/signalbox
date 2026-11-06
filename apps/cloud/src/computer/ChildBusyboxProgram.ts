import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import type { KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
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
  const hostFactories = new WeakMap<
    KernelBusyboxPort,
    (args: readonly string[]) => ReturnType<typeof createWorkerBusyboxHost>
  >();
  const dispatch = adaptChildArguments(options.executable, options.dispatch, hostFactories);
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
      const owner = createWorkerBusyboxHost(
        {
          context: childContext,
          ...(options.executable === "/bin/grep" ? { relativePathsFromCwd: true } : {}),
        },
        lease,
      );
      if (options.executable === "/bin/grep") {
        hostFactories.set(owner.host, (args) =>
          createWorkerBusyboxHost(
            {
              context: { ...context, args },
              relativePathsFromCwd: true,
            },
            lease,
          ),
        );
      }
      return owner;
    },
  });
}

function adaptChildArguments(
  executable: string,
  dispatch: ChildWorkerDispatch<KernelBusyboxPort>,
  hostFactories: WeakMap<
    KernelBusyboxPort,
    (args: readonly string[]) => ReturnType<typeof createWorkerBusyboxHost>
  >,
): ChildWorkerDispatch<KernelBusyboxPort> {
  return {
    async run(input, host, onMemoryLost) {
      const invocations = childArgumentInvocations(executable, input.command.argv);
      const exits: KernelCommandExit[] = [];
      const createHost = hostFactories.get(host);
      for (const [index, args] of invocations.entries()) {
        const adapted: ChildWorkerInvocation =
          args === input.command.argv
            ? input
            : { ...input, command: { ...input.command, argv: args } };
        const owner = index === 0 ? undefined : createHost?.(args);
        let exit: KernelCommandExit;
        try {
          exit = await dispatch.run(adapted, owner?.host ?? host, onMemoryLost);
        } finally {
          await owner?.close();
        }
        exits.push(exit);
        if (exit.signal !== 0 || exit.coreDumped) return exit;
      }
      return exits.length === 1 ? exits[0]! : combineGrepExits(exits);
    },
  };
}

function childArgumentInvocations(executable: string, argv: readonly string[]) {
  if (executable === "/bin/grep") {
    return grepArgumentInvocations(argv);
  }
  let args = argv;
  if (executable === "/bin/sed" && args[1] === "-i" && args[2] === "" && args.length >= 5) {
    args = [...args.slice(0, 2), ...args.slice(3)];
  }
  return [args];
}

function childArguments(executable: string, argv: readonly string[]) {
  return childArgumentInvocations(executable, argv)[0] ?? argv;
}

function grepArgumentInvocations(argv: readonly string[]) {
  let options = true;
  let pattern = false;
  let recursive = false;
  const operandIndexes: number[] = [];
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
    if (options && /^-A\d{1,3}$/.test(argument) && Number(argument.slice(2)) <= 100) continue;
    if (options && /^-[GEilnrv]+$/.test(argument)) {
      recursive ||= argument.includes("r");
      continue;
    }
    if (!pattern) {
      pattern = true;
      continue;
    }
    operandIndexes.push(index);
  }

  const dotRootCount = operandIndexes.filter((index) => argv[index] === ".").length;
  if (recursive && dotRootCount > 0 && operandIndexes.length > 1) {
    const operands = new Set(operandIndexes);
    // Ugrep's format option is global, so each root needs its own run to keep `./` on `.` only.
    return operandIndexes.map((operandIndex) => {
      const operand = argv[operandIndex]!;
      const rootArgs = argv.filter((_, index) => !operands.has(index) || index === operandIndex);
      const rootFormat = operand === "." ? ["--format=./%F%N%O%~"] : [];
      return [rootArgs[0]!, "--jobs=1", ...rootFormat, "-H", ...rootArgs.slice(1)];
    });
  }

  // Ugrep trims the trailing slash from ./, so format this recursive root's output explicitly.
  const rootFormat =
    recursive && operandIndexes.length === 1 && argv[operandIndexes[0]!] === "."
      ? ["--format=./%F%N%O%~"]
      : [];
  return [[argv[0]!, "--jobs=1", ...rootFormat, ...argv.slice(1)]];
}

function combineGrepExits(exits: readonly KernelCommandExit[]): KernelCommandExit {
  const error = exits.find(({ exitCode }) => exitCode > 1);
  if (error !== undefined) return error;
  return {
    exitCode: exits.some(({ exitCode }) => exitCode === 0) ? 0 : 1,
    signal: 0,
    coreDumped: false,
  };
}
