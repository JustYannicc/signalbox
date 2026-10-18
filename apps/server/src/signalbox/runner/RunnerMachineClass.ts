import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  REQUEST_HEAVY_MACHINE_COMMAND,
  REQUEST_HEAVY_MACHINE_REASON,
} from "@signalbox/runner-protocol/RunnerProtocol";

/**
 * When a turn on a light machine needs a heavy one (#113, #134). The light
 * class runs the harness and its subagents editing files; builds, tests,
 * installs and dev servers belong on the heavy class, and so does anything
 * that ran out of memory. The Runner checks every command the harness runs:
 * one of these, started, or one killed for memory, moves the turn up.
 *
 * Deterministic on purpose: a command either runs one of these tools or it
 * does not. Only the commands a shell line runs count, not their arguments or
 * heredoc bodies, so `echo "npm install"` or a markdown file written with
 * `cat <<EOF` stays light. A miss costs a slow command on a small machine,
 * never a lost turn, since running out of memory moves the turn up anyway.
 */

/** Tools whose runs can need project dependencies or more resources. */
const HEAVY_TOOLS: ReadonlySet<string> = new Set([
  "tsc",
  "webpack",
  "rollup",
  "turbo",
  "nx",
  "jest",
  "vitest",
  "playwright",
  "pytest",
  "make",
  "cmake",
  "ninja",
  "gradle",
  "gradlew",
  "mvn",
  "mvnw",
  "xcodebuild",
  "rustc",
  "gcc",
  "g++",
  "clang",
  "clang++",
  // A script may load dependencies without naming them in the command.
  "node",
  "nodejs",
]);

/** This tool declares a server that the next machine must keep running. */
const PREVIEW_SERVICE_START_TOOL_NAMES: ReadonlySet<string> = new Set([
  "preview_service_start",
  // MCP names from the provider adapters.
  "mcp__signalbox__preview_service_start",
  "signalbox.preview_service_start",
  "signalbox_preview_service_start",
]);

/** Tools whose run is heavy with one of these subcommands, within the next few words. */
const HEAVY_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    npm: ["install", "i", "ci", "add", "exec", "build", "test", "dev", "start", "serve", "preview"],
    pnpm: [
      "install",
      "i",
      "add",
      "exec",
      "dlx",
      "x",
      "build",
      "test",
      "dev",
      "start",
      "serve",
      "preview",
    ],
    yarn: ["install", "add", "exec", "dlx", "build", "test", "dev", "start", "serve", "preview"],
    bun: ["install", "i", "add", "exec", "x", "build", "test", "dev", "start", "preview"],
    vp: ["install", "i", "run", "exec", "build", "test", "dev", "check", "preview"],
    deno: ["install", "test", "compile", "serve"],
    vite: ["build", "dev", "serve", "preview"],
    next: ["build", "dev", "start"],
    cargo: ["build", "test", "run", "check", "bench", "install"],
    go: ["build", "test", "run", "install"],
    dotnet: ["build", "test", "run", "publish", "restore"],
    swift: ["build", "test", "run"],
    docker: ["build", "compose", "run"],
    pip: ["install"],
    pip3: ["install"],
    uv: ["sync", "pip", "run"],
    poetry: ["install", "run"],
    bundle: ["install", "exec"],
  }).map(([tool, subcommands]) => [tool, new Set(subcommands)]),
);

/** How far after the tool a subcommand may come, past flags like `--filter web`. */
const SUBCOMMAND_REACH = 4;

/** Words that run the command after them. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "corepack",
  "env",
  "time",
  "nohup",
  "exec",
  "command",
  "nice",
  "timeout",
]);

/** Shells whose `-c` script is itself a command line. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash"]);

/** SIGKILL's exit status: in a container, the kernel's out-of-memory killer. */
const KILLED_EXIT_CODE = 137;

/**
 * The commands a shell script runs, each as its words with quoting removed.
 * Quotes and backslashes group words as the shell does, operators and newlines
 * end a command, and a heredoc's body (`<<EOF` to `EOF`) is skipped as data.
 */
const commandsOf = (text: string): Array<Array<string>> => {
  const commands: Array<Array<string>> = [[]];
  let word: string | null = null;
  /** Heredoc delimiters whose bodies start after this line. */
  let heredocs: Array<string> = [];
  const add = (chars: string) => {
    word = (word ?? "") + chars;
  };
  const endWord = () => {
    if (word !== null) commands[commands.length - 1]!.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (commands[commands.length - 1]!.length > 0) commands.push([]);
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      // `\` then a newline continues the line.
      if (text[index + 1] !== "\n") add(text[index + 1] ?? "");
      index += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      add(text.slice(index + 1, end));
      index = end + 1;
    } else if (char === '"') {
      index++;
      while (index < text.length && text[index] !== '"') {
        // Inside double quotes a backslash only escapes these.
        if (text[index] === "\\" && '"\\$`'.includes(text[index + 1] ?? "")) index++;
        add(text[index] ?? "");
        index++;
      }
      index++;
    } else if (char === "<" && text[index + 1] === "<" && text[index + 2] !== "<") {
      endWord();
      const heredoc = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(text.slice(index));
      if (heredoc !== null) heredocs.push(heredoc[2]!);
      index += heredoc?.[0].length ?? 2;
    } else if (char === "\n") {
      endCommand();
      index++;
      // A heredoc's body runs to its delimiter's own line.
      for (const delimiter of heredocs) {
        while (index < text.length) {
          const lineEnd = text.indexOf("\n", index);
          const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
          index = lineEnd === -1 ? text.length : lineEnd + 1;
          if (line.trim() === delimiter) break;
        }
      }
      heredocs = [];
    } else if (/\s/.test(char)) {
      endWord();
      index++;
    } else if (";&|(){}<>`".includes(char) || (char === "$" && text[index + 1] === "(")) {
      endCommand();
      index++;
    } else {
      add(char);
      index++;
    }
  }
  endWord();
  return commands.filter((command) => command.length > 0);
};

const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** One command after its wrappers, or the script a shell passes to `-c`. */
const unwrapCommand = (
  words: ReadonlyArray<string>,
): { readonly command: ReadonlyArray<string>; readonly script?: string } => {
  let start = 0;
  while (
    start < words.length &&
    (WRAPPERS.has(baseName(words[start]!)) ||
      /^\w+=/.test(words[start]!) ||
      words[start]!.startsWith("-") ||
      /^\d+[smh]?$/.test(words[start]!))
  ) {
    start++;
  }
  const tool = words[start] === undefined ? undefined : baseName(words[start]!);
  if (tool === undefined) return { command: [] };
  if (SHELLS.has(tool)) {
    const flag = words.findIndex((word, index) => index > start && /^-\w*c\w*$/.test(word));
    const script = flag === -1 ? undefined : words[flag + 1];
    return { command: [], ...(script === undefined ? {} : { script }) };
  }
  return { command: words.slice(start) };
};

/** The commands wrappers and shell `-c` scripts actually run. */
const executedCommandsOf = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  const commands: Array<ReadonlyArray<string>> = [];
  const visit = (script: string) => {
    for (const words of commandsOf(script)) {
      const unwrapped = unwrapCommand(words);
      if (unwrapped.script !== undefined) visit(unwrapped.script);
      else if (unwrapped.command.length > 0) commands.push(unwrapped.command);
    }
  };
  visit(text);
  return commands;
};

/** The heavy tool one already-unwrapped command runs, if any. */
const heavyTool = (words: ReadonlyArray<string>): string | null => {
  const [rawTool, ...args] = words;
  if (rawTool === undefined) return null;
  const nodeModulesBin = /(?:^|\/)node_modules\/\.bin\/([^/]+)$/u.exec(rawTool);
  if (nodeModulesBin !== null) return nodeModulesBin[1]!;
  const tool = baseName(rawTool);
  if (tool === "npx" || tool === "bunx") {
    const nested = unwrapCommand(args);
    const nestedTool =
      nested.script === undefined ? heavyTool(nested.command) : heavyCommand(nested.script);
    return nestedTool ?? tool;
  }
  if (tool === "node" || tool === "nodejs") {
    return args.length === 1 && (args[0] === "-v" || args[0] === "--version") ? null : tool;
  }
  if (HEAVY_TOOLS.has(tool)) return tool;
  const subcommands = HEAVY_SUBCOMMANDS.get(tool);
  // `npm run build`: the script's name decides, as `npm build` would.
  const found = args.slice(0, SUBCOMMAND_REACH).find((word) => subcommands?.has(word) === true);
  if (found !== undefined) return `${tool} ${found}`;
  if (!["npm", "pnpm", "yarn", "bun", "vp"].includes(tool)) return null;
  const generic = args
    .slice(0, SUBCOMMAND_REACH)
    .find((word) => ["run", "run-script", "exec", "dlx", "x"].includes(word));
  return generic === undefined ? null : `${tool} ${generic}`;
};

interface MachineCommandNeed {
  readonly heavyTool: string | null;
  readonly requestsHeavyMachine: boolean;
  readonly pureHeavyMachineRequest: boolean;
}

/** Classifies one shell item in one traversal so its two machine rules agree. */
const machineCommandNeed = (text: string): MachineCommandNeed => {
  let heavy: string | null = null;
  let requestsHeavy = false;
  const commands = executedCommandsOf(text);
  for (const words of commands) {
    if (!requestsHeavy && words.join(" ") === REQUEST_HEAVY_MACHINE_COMMAND) {
      requestsHeavy = true;
    }
    if (heavy === null) heavy = heavyTool(words);
  }
  return {
    heavyTool: heavy,
    requestsHeavyMachine: requestsHeavy,
    pureHeavyMachineRequest:
      requestsHeavy &&
      commands.length === 1 &&
      commands[0]?.join(" ") === REQUEST_HEAVY_MACHINE_COMMAND,
  };
};

/** The heavy tool `command` runs, if any: `npm build`, `cargo test`, `tsc`. */
export const heavyCommand = (command: string): string | null =>
  machineCommandNeed(command).heavyTool;

export interface OutgrownCommandDecision {
  readonly reason: string | null;
  /** The explicit capacity command is an internal request, not transcript work. */
  readonly suppressTranscript: boolean;
}

/** Why a provider command moves the run up, and whether it is internal. */
export const outgrownCommandDecision = (event: ProviderAdapterV2Event): OutgrownCommandDecision => {
  if (event.type !== "turn_item.updated") return { reason: null, suppressTranscript: false };
  const item = event.turnItem;
  if (item.type === "dynamic_tool") {
    return {
      reason:
        (item.status === "running" || item.status === "pending") &&
        item.toolName !== null &&
        PREVIEW_SERVICE_START_TOOL_NAMES.has(item.toolName)
          ? "Starting `preview_service_start`, a dev server that needs a bigger machine."
          : null,
      suppressTranscript: false,
    };
  }
  if (item.type !== "command_execution") return { reason: null, suppressTranscript: false };
  const need = machineCommandNeed(item.input);
  if (item.status === "pending" || item.status === "running" || item.status === "completed") {
    if (need.requestsHeavyMachine) {
      return {
        reason: REQUEST_HEAVY_MACHINE_REASON,
        suppressTranscript: need.pureHeavyMachineRequest,
      };
    }
  }
  if (item.status === "running" || item.status === "pending") {
    return {
      reason:
        need.heavyTool === null
          ? null
          : `It runs \`${need.heavyTool}\`, which needs a bigger machine.`,
      suppressTranscript: false,
    };
  }
  // Codex reports the exit code; Claude's Bash only says so in its failed output.
  const killed =
    item.exitCode === KILLED_EXIT_CODE ||
    ((item.status === "failed" || item.outputIndicatesFailure === true) &&
      /\bexit code 137\b/i.test(item.output ?? ""));
  return {
    reason: killed ? "A command ran out of memory." : null,
    suppressTranscript: need.pureHeavyMachineRequest,
  };
};

/** Why `event` moves its run to heavy, preserving the existing classifier API. */
export const outgrownBy = (event: ProviderAdapterV2Event): string | null =>
  outgrownCommandDecision(event).reason;
