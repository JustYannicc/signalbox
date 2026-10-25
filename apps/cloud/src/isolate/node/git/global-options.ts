export interface ParsedGitGlobalOptions {
  readonly cwd: readonly string[];
  readonly command: string | undefined;
  readonly commandArgs: readonly string[];
  readonly unsupportedOption: string | undefined;
}

const VALUE_OPTIONS = [
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
] as const;

const UNSUPPORTED_FLAGS = new Set([
  "--paginate",
  "-p",
  "--no-replace-objects",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
]);

export function parseGitGlobalOptions(argv: readonly string[]): ParsedGitGlobalOptions {
  const args = argv.slice(1);
  const cwd: string[] = [];
  let unsupportedOption: string | undefined;
  let index = 0;

  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "-C") {
      const path = args[index + 1];
      if (path === undefined || path.length === 0) break;
      cwd.push(path);
      index += 2;
      continue;
    }
    if (arg === "--no-pager" || arg === "-P") {
      index += 1;
      continue;
    }
    if (arg === "-c" || arg.startsWith("-c=") || (arg.startsWith("-c") && arg.length > 2)) {
      unsupportedOption ??= "-c";
      index += arg === "-c" ? 2 : 1;
      continue;
    }
    if (UNSUPPORTED_FLAGS.has(arg)) {
      unsupportedOption ??= arg;
      index += 1;
      continue;
    }
    const valueOption = optionValue(args, index);
    if (valueOption !== undefined) {
      unsupportedOption ??= valueOption.option;
      index = valueOption.index + 1;
      continue;
    }
    if (arg.startsWith("-")) break;
    break;
  }

  return {
    cwd,
    command: args[index],
    commandArgs: args.slice(index + 1),
    unsupportedOption,
  };
}

function optionValue(
  args: readonly string[],
  index: number,
): { readonly option: string; readonly index: number } | undefined {
  const arg = args[index]!;
  for (const option of VALUE_OPTIONS) {
    if (arg === option) return { option, index: index + 1 };
    if (arg.startsWith(`${option}=`)) return { option, index };
  }
  return undefined;
}
