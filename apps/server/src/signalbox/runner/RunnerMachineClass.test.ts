import { describe, expect, it } from "@effect/vitest";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

import { heavyCommand, outgrownBy } from "./RunnerMachineClass.ts";

const dynamicToolEvent = (toolName: string | null, status: "pending" | "running" | "completed") =>
  ({
    type: "turn_item.updated",
    turnItem: { type: "dynamic_tool", toolName, status },
  }) as unknown as ProviderAdapterV2Event;

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

  it("moves package scripts to heavy while keeping file work and shell data light", () => {
    expect(heavyCommand("npm run lint")).toBe("npm run");
    expect(heavyCommand("npm run-script lint")).toBe("npm run-script");
    expect(heavyCommand('echo "run npm install first" >> notes.md')).toBeNull();
    expect(heavyCommand("printf '%s\\n' run exec dlx x")).toBeNull();
    expect(heavyCommand('git commit -m "make the build pass"')).toBeNull();
    expect(
      heavyCommand("cat > docs/setup.md <<'EOF'\nnpm install\nmake\nEOF\nwc -l docs/setup.md"),
    ).toBeNull();
    expect(heavyCommand("ls -la notes && wc -l notes/*.md")).toBeNull();
  });

  it("moves package scripts, package executors and Node commands to a heavy machine", () => {
    expect(heavyCommand("pnpm --filter web exec eslint .")).toBe("pnpm exec");
    expect(heavyCommand("corepack pnpm --filter web exec eslint .")).toBe("pnpm exec");
    expect(heavyCommand("yarn workspace web run typecheck")).toBe("yarn run");
    expect(heavyCommand("bun x vite build")).toBe("bun x");
    expect(heavyCommand("bunx tsx scripts/check-config.ts")).toBe("bunx");
    expect(heavyCommand("./apps/web/node_modules/.bin/eslint .")).toBe("eslint");
    expect(heavyCommand("node scripts/check-config.js")).toBe("node");
  });

  it("keeps Node version queries light while Node code stays heavy", () => {
    for (const command of ["node -v", "node --version", "nodejs -v", "nodejs --version"]) {
      expect(heavyCommand(command)).toBeNull();
    }
    expect(heavyCommand("node -e \"require('./package.json')\"")).toBe("node");
    expect(heavyCommand("node -p \"require('./package.json').name\"")).toBe("node");
  });

  it("moves a running preview service start tool to a heavy machine across adapter names", () => {
    const reason = "Starting `preview_service_start`, a dev server that needs a bigger machine.";
    for (const toolName of [
      "preview_service_start",
      "mcp__signalbox__preview_service_start",
      "signalbox.preview_service_start",
      "signalbox_preview_service_start",
    ]) {
      expect(outgrownBy(dynamicToolEvent(toolName, "pending"))).toBe(reason);
      expect(outgrownBy(dynamicToolEvent(toolName, "running"))).toBe(reason);
    }
    expect(outgrownBy(dynamicToolEvent("mcp__signalbox__preview_service_stop", "running"))).toBe(
      null,
    );
    expect(outgrownBy(dynamicToolEvent("mcp__signalbox__preview_service_start", "completed"))).toBe(
      null,
    );
  });

  it("does not classify package or Node commands written as shell data", () => {
    expect(heavyCommand('echo "npm run build" && git status --short')).toBeNull();
    expect(heavyCommand("cat <<'EOF'\nnode app.js\nnpm run build\nEOF\nls")).toBeNull();
  });
});
