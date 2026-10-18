// @effect-diagnostics nodeBuiltinImport:off - tests assert native spawn arguments at this boundary.
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vite-plus/test";

import type { ExecCommand } from "@signalbox/runner-protocol/ExecProtocol";

import { makeRunnerExecProcessHost } from "./RunnerExecProcessHost.ts";

describe("RunnerExecProcessHost", () => {
  it("keeps the canonical cwd and passes exact command fields to native spawn", () => {
    const spawn = vi.fn();
    const host = makeRunnerExecProcessHost({
      realpath: (path) => {
        if (path === "/workspace" || path === "/workspace/src") return path;
        throw new Error("not mounted");
      },
      isDirectory: () => true,
      spawn: spawn as unknown as typeof NodeChildProcess.spawn,
    });
    const command = {
      type: "start",
      generation: 4,
      processId: "proc-4",
      requestId: "start-4",
      executable: "/usr/bin/tool",
      argv: ["tool-as-argv0", "--literal", "value"],
      cwd: "/workspace/src",
      env: { API_MODE: "test" },
    } satisfies Extract<ExecCommand, { readonly type: "start" }>;

    const directory = host.resolveWorkingDirectory(command.cwd);
    expect(directory).toEqual({ _tag: "ready", cwd: "/workspace/src" });
    if (directory._tag !== "ready") throw new Error("expected a ready canonical workspace");
    host.spawn(command, directory.cwd);

    expect(spawn).toHaveBeenCalledWith("/usr/bin/tool", ["--literal", "value"], {
      argv0: "tool-as-argv0",
      cwd: "/workspace/src",
      env: { API_MODE: "test" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(spawn.mock.calls[0]?.[2]?.cwd).toBe("/workspace/src");
  });

  it("requires an existing OS canonical workspace mount", () => {
    const host = makeRunnerExecProcessHost({
      realpath: (path) => {
        if (path === "/workspace") throw new Error("mount is absent");
        throw new Error("unreachable");
      },
      isDirectory: () => true,
    });

    expect(host.resolveWorkingDirectory("/workspace")).toEqual({ _tag: "workspace_not_ready" });
    expect(host.resolveWorkingDirectory("/workspace/../../outside")).toEqual({
      _tag: "invalid_cwd",
    });
  });

  it("rejects a symlink from the canonical name to a physical Runner workspace", () => {
    const host = makeRunnerExecProcessHost({
      realpath: (path) => {
        if (path === "/workspace") return "/home/user/signalbox/workspaces/thread/drive";
        if (path === "/workspace/src") return "/home/user/signalbox/workspaces/thread/drive/src";
        throw new Error("not mounted");
      },
      isDirectory: () => true,
    });

    expect(host.resolveWorkingDirectory("/workspace/src")).toEqual({ _tag: "workspace_not_ready" });
  });
});
