import { describe, expect, it } from "@effect/vitest";

import { heavyCommand } from "./RunnerMachineClass.ts";

describe("heavyCommand", () => {
  it("finds builds, tests, installs and dev servers", () => {
    expect(heavyCommand("npm run build")).toBe("npm build");
    expect(heavyCommand("pnpm --filter web test")).toBe("pnpm test");
    expect(heavyCommand("cd app && yarn install --frozen-lockfile")).toBe("yarn install");
    expect(heavyCommand("./node_modules/.bin/tsc --noEmit")).toBe("tsc");
    expect(heavyCommand("cargo test --release")).toBe("cargo test");
    expect(heavyCommand("NODE_ENV=production timeout 600 npx vite build")).toBe("vite build");
  });

  it("finds a build after a heredoc in a shell script with escaped quotes", () => {
    // What Codex ran on a live light machine: one script writes a file, then builds.
    const script = [
      "mkdir -p hello && cat > hello/package.json <<'EOF'",
      '{ "scripts": { "build": "node -e \\"console.log(42)\\"" } }',
      "EOF",
      "cd hello && npm run build",
    ].join("\n");
    const quoted = `/bin/bash -lc "${script.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    expect(heavyCommand(quoted)).toBe("npm build");
    // The same script with the build in the heredoc's body is only data.
    expect(heavyCommand(quoted.replace("EOF\ncd hello", "cd hello"))).toBeNull();
    expect(heavyCommand(script)).toBe("npm build");
    expect(heavyCommand('/bin/bash -lc "echo \\"npm install\\" && ls"')).toBeNull();
    expect(heavyCommand("npm \\\n  run build")).toBe("npm build");
  });

  it("looks inside a shell's -c script, as Codex runs commands", () => {
    expect(heavyCommand("/bin/bash -lc 'npm run dev -- --port 3000'")).toBe("npm dev");
    expect(heavyCommand(`/bin/zsh -lc "sed -n 1,20p README.md"`)).toBeNull();
  });

  it("leaves file work, arguments and heredoc bodies light", () => {
    expect(heavyCommand("npm run lint")).toBeNull();
    expect(heavyCommand('echo "run npm install first" >> notes.md')).toBeNull();
    expect(heavyCommand('git commit -m "make the build pass"')).toBeNull();
    expect(
      heavyCommand("cat > docs/setup.md <<'EOF'\nnpm install\nmake\nEOF\nwc -l docs/setup.md"),
    ).toBeNull();
    expect(heavyCommand("ls -la notes && wc -l notes/*.md")).toBeNull();
  });
});
