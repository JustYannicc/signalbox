/**
 * Sorts an agent's shell command into a coarse workload category for usage
 * analytics (#116), on the self-hosted server and in a cloud thread's object.
 * The command text never leaves where it was classified, just the category.
 *
 * @module commandCategory
 */

export const COMMAND_CATEGORIES = [
  "install",
  "build",
  "test",
  "typecheck",
  "git",
  "devServer",
  "other",
] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

const RUNNER = String.raw`(?:npm|pnpm|yarn|bun|vp|vpr|deno)`;
const SCRIPT = String.raw`(?:${RUNNER}(?:\s+run)?|make|just|task|turbo(?:\s+run)?|nx(?:\s+run)?)`;
const anyOf = (patterns: ReadonlyArray<string>) => new RegExp(`^(?:${patterns.join("|")})`);

// Each pattern is anchored at the start of one simple command. When a command
// line chains several, the earliest category in this list wins: it is the one
// that most likely dominates the time.
const RULES: ReadonlyArray<readonly [Exclude<CommandCategory, "other">, RegExp]> = [
  [
    "devServer",
    anyOf([
      String.raw`${SCRIPT}\s+(?:dev|start|serve|preview)\b`,
      String.raw`(?:vite|next|nuxt|astro|remix|wrangler|expo|netlify)\s+(?:dev|start)\b`,
      String.raw`vite\s*$`,
      String.raw`(?:uvicorn|gunicorn|nodemon)\b`,
      String.raw`flask\s+run\b`,
      String.raw`(?:bin/)?rails\s+s(?:erver)?\b`,
      String.raw`python3?\s+(?:manage\.py\s+runserver|-m\s+http\.server)\b`,
    ]),
  ],
  [
    "install",
    anyOf([
      String.raw`${RUNNER}\s+(?:i|install|add|ci)\b`,
      String.raw`(?:pip3?|uv\s+pip|pipx|gem|brew|cargo|go|poetry|bundle|composer|pod)\s+install\b`,
      String.raw`python3?\s+-m\s+pip\s+install\b`,
      String.raw`uv\s+(?:sync|add)\b`,
      String.raw`apt(?:-get)?\s+install\b`,
      String.raw`go\s+mod\s+download\b`,
      String.raw`cargo\s+fetch\b`,
    ]),
  ],
  [
    "build",
    anyOf([
      String.raw`${SCRIPT}\s+(?:build|compile|bundle|package)\b`,
      String.raw`(?:vite|next|nuxt|astro|remix)\s+build\b`,
      String.raw`(?:cargo|go|swift|dotnet|docker|zig|bazel)\s+build\b`,
      String.raw`(?:make|ninja|cmake|xcodebuild|gradle|gradlew|mvn|tsup|webpack|rollup|esbuild|parcel)\b`,
    ]),
  ],
  [
    "test",
    anyOf([
      String.raw`${SCRIPT}\s+test\b`,
      String.raw`${RUNNER}\s+t\b`,
      String.raw`(?:vitest|jest|pytest|mocha|rspec|phpunit)\b`,
      String.raw`(?:cargo|go|deno|swift|dotnet|mix)\s+test\b`,
      String.raw`playwright\s+test\b`,
      String.raw`python3?\s+-m\s+(?:pytest|unittest)\b`,
    ]),
  ],
  [
    "typecheck",
    anyOf([
      String.raw`${SCRIPT}\s+(?:typecheck|type-check|check-types|tsc)\b`,
      String.raw`(?:tsc|tsgo|vue-tsc|mypy|pyright|basedpyright)\b`,
      String.raw`cargo\s+(?:check|clippy)\b`,
    ]),
  ],
  ["git", anyOf([String.raw`(?:git|gh)\b`])],
];

// Prefixes that only change how the real program runs.
const PREFIX =
  /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|time|nice|env|exec|command|npx|bunx|pnpx|uvx|uv\s+run|poetry\s+run|bundle\s+exec|pnpm\s+exec|yarn\s+exec|vp\s+exec|-\S+)\s+)+/;

/**
 * Codex reports commands wrapped in a login shell (`/bin/zsh -lc '…'`); the
 * category belongs to what the shell runs.
 */
function unwrapShell(command: string): string {
  const wrapped = /^\s*\S*\b(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return wrapped?.[2] ?? command;
}

export function classifyCommand(command: string): CommandCategory {
  const segments = unwrapShell(command)
    .split(/&&|\|\||[;|\n]/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^[({\s]+/, "")
        .replace(PREFIX, "")
        // `./node_modules/.bin/vitest` and `/usr/bin/git` are their basename.
        .replace(/^[^\s/]*\/(?:\S*\/)?/, ""),
    );
  for (const [category, pattern] of RULES) {
    if (segments.some((segment) => pattern.test(segment))) return category;
  }
  return "other";
}
