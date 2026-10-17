import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

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
  // MCP names from the Codex/Cursor/Pi, ACP, and OpenCode adapters.
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

/** The heavy tool `words` runs, if any. */
const heavyTool = (words: ReadonlyArray<string>): string | null => {
  // Past `sudo`, `env X=1`, `timeout 60` and the like, to the command itself.
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
  if (tool === undefined) return null;
  const nodeModulesBin = /(?:^|\/)node_modules\/\.bin\/([^/]+)$/u.exec(words[start]!);
  if (nodeModulesBin !== null) return nodeModulesBin[1]!;
  if (SHELLS.has(tool)) {
    const flag = words.findIndex((word, index) => index > start && /^-\w*c\w*$/.test(word));
    const script = flag === -1 ? undefined : words[flag + 1];
    return script === undefined ? null : heavyCommand(script);
  }
  if (tool === "npx" || tool === "bunx") return heavyTool(words.slice(start + 1)) ?? tool;
  if (tool === "node" || tool === "nodejs") {
    const args = words.slice(start + 1);
    return args.length === 1 && (args[0] === "-v" || args[0] === "--version") ? null : tool;
  }
  if (HEAVY_TOOLS.has(tool)) return tool;
  const subcommands = HEAVY_SUBCOMMANDS.get(tool);
  const args = words.slice(start + 1, start + 1 + SUBCOMMAND_REACH);
  // `npm run build`: the script's name decides, as `npm build` would.
  const found = args.find((word) => subcommands?.has(word) === true);
  if (found !== undefined) return `${tool} ${found}`;
  if (!["npm", "pnpm", "yarn", "bun", "vp"].includes(tool)) return null;
  const generic = args.find(
    (word) =>
      word === "run" || word === "run-script" || word === "exec" || word === "dlx" || word === "x",
  );
  return generic === undefined ? null : `${tool} ${generic}`;
};

/** The heavy tool `command` runs, if any: `npm build`, `cargo test`, `tsc`. */
export const heavyCommand = (command: string): string | null => {
  for (const words of commandsOf(command)) {
    const tool = heavyTool(words);
    if (tool !== null) return tool;
  }
  return null;
};

/**
 * Why `event` moves its turn to a heavy machine, or null. A heavy command
 * counts as soon as it starts, so the light machine is let go before it gets
 * far; a killed one counts when it ends.
 */
export const outgrownBy = (event: ProviderAdapterV2Event): string | null => {
  if (event.type !== "turn_item.updated") return null;
  const item = event.turnItem;
  if (item.type === "dynamic_tool") {
    return (item.status === "running" || item.status === "pending") &&
      item.toolName !== null &&
      PREVIEW_SERVICE_START_TOOL_NAMES.has(item.toolName)
      ? "Starting `preview_service_start`, a dev server that needs a bigger machine."
      : null;
  }
  if (item.type !== "command_execution") return null;
  if (item.status === "running" || item.status === "pending") {
    const tool = heavyCommand(item.input);
    return tool === null ? null : `It runs \`${tool}\`, which needs a bigger machine.`;
  }
  // Codex reports the exit code; Claude's Bash only says so in its failed output.
  const killed =
    item.exitCode === KILLED_EXIT_CODE ||
    ((item.status === "failed" || item.outputIndicatesFailure === true) &&
      /\bexit code 137\b/i.test(item.output ?? ""));
  return killed ? "A command ran out of memory." : null;
};
