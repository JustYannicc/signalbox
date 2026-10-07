import { describe, expect, it } from "vite-plus/test";

import { classifyCommand } from "./commandCategory.ts";

describe("classifyCommand", () => {
  it.each([
    ["vp i", "install"],
    ["pnpm install --frozen-lockfile", "install"],
    ["uv sync", "install"],
    ["python -m pip install -r requirements.txt", "install"],
    ["cargo build --release", "build"],
    ["npm run build", "build"],
    ["./gradlew assembleDebug", "build"],
    ["vp test run apps/server/src/foo.test.ts", "test"],
    ["./node_modules/.bin/vitest run", "test"],
    ["uv run pytest -q", "test"],
    ["go test ./...", "test"],
    ["vp run typecheck", "typecheck"],
    ["npx tsc --noEmit -p apps/web", "typecheck"],
    ["cargo clippy", "typecheck"],
    ["git status --short", "git"],
    ["/usr/bin/git diff", "git"],
    ["gh pr view 12", "git"],
    ["vp run dev", "devServer"],
    ["PORT=4000 npm start", "devServer"],
    ["python3 -m http.server 8000", "devServer"],
    ["rg -n foo src", "other"],
    ["sed -n 1,20p README.md", "other"],
    ["", "other"],
  ] as const)("%s -> %s", (command, category) => {
    expect(classifyCommand(command)).toBe(category);
  });

  it("classifies the command Codex's login shell runs", () => {
    expect(classifyCommand(`/bin/zsh -lc 'cd apps/web && vp test run'`)).toBe("test");
    expect(classifyCommand(`bash -lc "cargo build"`)).toBe("build");
  });

  it("ignores words in arguments, like a commit message", () => {
    expect(classifyCommand(`git commit -m "fix vitest build"`)).toBe("git");
  });

  it("picks the costliest kind in a chain", () => {
    expect(classifyCommand("git pull && pnpm install && pnpm build")).toBe("install");
    expect(classifyCommand("cd app; npm run build | tail -5")).toBe("build");
  });
});
