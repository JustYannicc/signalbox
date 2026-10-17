// @effect-diagnostics nodeBuiltinImport:off - verifies dependency-free harness session files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  recordSession,
  processSessionId,
  sessions,
} from "../../packages/shared/src/agentProcessSessions.ts";

describe("agent session ownership", () => {
  it("never assigns a human command to an agent just because they share a checkout", async () => {
    const worktreePath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-sessions-"));
    try {
      await recordSession(worktreePath, "one", false);
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
});
