import { createNodeFs } from "../../../../src/isolate/NodeFs.ts";
import type { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import type { NodeRuntimeIdentity } from "../../../../src/isolate/NodeProcess.ts";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";

export interface ClaudeSeedPaths {
  readonly home: string;
  readonly cwd: string;
  readonly settings: string;
  readonly projectState: string;
}

export function claudeSeedPaths(input: { home: string; cwd: string }): ClaudeSeedPaths {
  if (!input.home.startsWith("/") || !input.cwd.startsWith("/"))
    throw new TypeError("Claude qualification paths must be absolute guest paths.");
  const project = input.cwd.replaceAll("/", "-") || "-";
  return {
    home: input.home,
    cwd: input.cwd,
    settings: `${input.home}/.claude/settings.json`,
    projectState: `${input.home}/.claude/projects/${project}`,
  };
}

export function prepareClaudeSeed(files: KernelFileSystem, paths: ClaudeSeedPaths): void {
  const fs = createNodeFs(files).fs;
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(`${paths.home}/.claude`, { recursive: true });
  fs.mkdirSync(paths.projectState, { recursive: true });
}

export function claudeNodeRuntimeIdentity(home: string): NodeRuntimeIdentity {
  return {
    version: "v24.21.0",
    versions: { node: "24.21.0", bun: "1.3.11" },
    platform: "linux",
    arch: "x64",
    type: "Linux",
    endianness: "LE",
    availableParallelism: 1,
    user: { username: "qualification", uid: 1000, gid: 1000, shell: "/bin/bash" },
    homedir: home,
    tmpdir: "/tmp",
    pid: 1,
    ppid: 0,
    execPath: "/runtime/claude",
    argv0: "claude",
    argv: ["claude"],
  };
}

export const claudeSystemIdentity = (threadId: string) => systemIdentityForThread(threadId);
