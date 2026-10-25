// @effect-diagnostics nodeBuiltinImport:off - verifies dependency-free harness session files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  recordSession,
  processSessionId,
  ownedSessionId,
  sessions,
} from "@t3tools/shared/agentProcessSessions";

describe("agent session ownership", () => {
  it("never assigns a human command to an agent just because they share a checkout", async () => {
    const worktreePath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-sessions-"));
    try {
      await recordSession(worktreePath, "one", false);
      expect(await ownedSessionId(worktreePath)).toBeUndefined();
      expect(processSessionId()).not.toBe("one");
      await recordSession(worktreePath, "two", false);
      expect(processSessionId()).not.toBe("one");
      expect(processSessionId()).not.toBe("two");
      expect(processSessionId("explicit")).toBe("explicit");
      await recordSession(worktreePath, "one", true);
      expect(processSessionId()).not.toBe("two");
      expect(await sessions(worktreePath)).toContainEqual({ sessionId: "one", ended: true });
    } finally {
      await NodeFSP.rm(worktreePath, { recursive: true, force: true });
    }
  });

  it("uses exact Codex runtime IDs across root sessions and subagents sharing a checkout", async () => {
    const worktreePath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-sessions-"));
    try {
      await recordSession(worktreePath, "parent", false, "parent");
      await recordSession(worktreePath, "parent/child", false, "child");
      await recordSession(worktreePath, "other", false, "other");
      expect(await ownedSessionId(worktreePath, { codexThreadId: "parent" })).toBe("parent");
      expect(await ownedSessionId(worktreePath, { codexThreadId: "child" })).toBe("parent/child");
      expect(await ownedSessionId(worktreePath, { codexThreadId: "fork" })).toBe("fork");
      expect(await ownedSessionId(worktreePath, { codexThreadId: "unregistered" })).toBe(
        "unregistered",
      );
      expect(
        await ownedSessionId(worktreePath, { explicit: "explicit", codexThreadId: "child" }),
      ).toBe("explicit");
      await recordSession(worktreePath, "parent/child", true, "child");
      expect(await ownedSessionId(worktreePath, { codexThreadId: "child" })).toBe("parent/child");
      expect(await ownedSessionId(worktreePath)).toBeUndefined();
    } finally {
      await NodeFSP.rm(worktreePath, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous runtime ownership rather than choosing a session", async () => {
    const worktreePath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-sessions-"));
    try {
      await recordSession(worktreePath, "one", false, "runtime");
      await recordSession(worktreePath, "two", false, "runtime");
      await expect(ownedSessionId(worktreePath, { codexThreadId: "runtime" })).rejects.toThrow(
        "Multiple sessions claim the same Codex thread ID",
      );
    } finally {
      await NodeFSP.rm(worktreePath, { recursive: true, force: true });
    }
  });

  it("requires an explicit owner when Claude's environment is shared with live subagents", async () => {
    const worktreePath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-sessions-"));
    try {
      await recordSession(worktreePath, "parent", false, "parent");
      await recordSession(worktreePath, "parent/child", false, "child");
      await expect(
        ownedSessionId(worktreePath, { environmentSessionId: "parent" }),
      ).rejects.toThrow("Inherited session ownership is ambiguous");
      expect(
        await ownedSessionId(worktreePath, {
          explicit: "parent/child",
          environmentSessionId: "parent",
        }),
      ).toBe("parent/child");
      expect(
        await ownedSessionId(worktreePath, { explicit: "parent", environmentSessionId: "parent" }),
      ).toBe("parent");
      expect(
        await ownedSessionId(worktreePath, {
          codexThreadId: "child",
          environmentSessionId: "parent",
        }),
      ).toBe("parent/child");
      await expect(
        ownedSessionId(worktreePath, { explicit: "", environmentSessionId: "parent" }),
      ).rejects.toThrow("Session ID must not be empty");
      await recordSession(worktreePath, "parent/child", true, "child");
      expect(await ownedSessionId(worktreePath, { environmentSessionId: "parent" })).toBe("parent");
    } finally {
      await NodeFSP.rm(worktreePath, { recursive: true, force: true });
    }
  });
});
