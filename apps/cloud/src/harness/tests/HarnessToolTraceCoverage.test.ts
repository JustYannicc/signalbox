import { describe, expect, it } from "vite-plus/test";
import { createHarnessToolTraceLedger } from "../HarnessToolTrace.ts";
import { wrappedCommand } from "./toolTraceFixture.ts";

const pre = {
  hook_event_name: "PreToolUse",
  session_id: "session",
  tool_use_id: "call",
  tool_name: "Read",
  tool_input: { file_path: "/work/file" },
  cwd: "/work",
};
const post = { ...pre, hook_event_name: "PostToolUse", tool_response: { content: "file" } };

describe("tool trace observation coverage", () => {
  it.each([
    "missing",
    "attached-only",
    "drained-only",
    "late-attach",
    "early-drain",
    "incomplete",
    "duplicate",
  ])("never reports no-child when capture coverage is %s", (scenario) => {
    const ledger = createHarnessToolTraceLedger();
    if (!["missing", "drained-only", "late-attach"].includes(scenario))
      ledger.observeProcessCapture("host", "attached", true, { installed: true });
    if (scenario === "duplicate") ledger.observeProcessCapture("host", "attached", true, {});
    ledger.observeHook("host", "PreToolUse", pre, "call");
    if (scenario === "late-attach") ledger.observeProcessCapture("host", "attached", true, {});
    if (scenario === "early-drain") ledger.observeProcessCapture("host", "drained", true, {});
    ledger.observeHook("host", "PostToolUse", post, "call");
    if (!["missing", "attached-only", "early-drain"].includes(scenario))
      ledger.observeProcessCapture("host", "drained", scenario !== "incomplete", { joined: true });
    const result = ledger.finalize([{ id: "call", name: "Read", processKey: "host" }]);
    expect(result.verdicts[0]?.kind).toBe("gap");
    expect(result.coverage.toolCalls).toEqual({ denominator: 1, joined: 0, noChild: 0, gaps: 1 });
  });

  it("requires capture coverage even when a unique child was observed", () => {
    const ledger = createHarnessToolTraceLedger();
    const bashPre = { ...pre, tool_name: "Bash", tool_input: { command: "printf exact" } };
    ledger.observeHook("host", "PreToolUse", bashPre, "call");
    ledger.observeChildSpawn({
      childId: "child",
      processKey: "host",
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "-l", wrappedCommand("printf exact")],
      cwd: "/work",
      raw: {},
    });
    ledger.observeChildClose("child", { args: [null, null] });
    ledger.observeHook(
      "host",
      "PostToolUse",
      { ...bashPre, hook_event_name: "PostToolUse" },
      "call",
    );
    const result = ledger.finalize([{ id: "call", name: "Bash" }]);
    expect(result.verdicts[0]).toMatchObject({
      kind: "gap",
      reasons: ["process-capture-coverage-unproven"],
    });
    expect(result.coverage.childProcesses.associated).toBe(0);
  });

  it("retains process and child tables through JSON round trips", () => {
    const ledger = createHarnessToolTraceLedger();
    const bashPre = { ...pre, tool_name: "Bash", tool_input: { command: "printf exact" } };
    ledger.observeProcessCapture("host", "attached", true, { observer: "installed" });
    ledger.observeHook("host", "PreToolUse", bashPre, "call");
    const argv = ["/bin/bash", "-c", "-l", wrappedCommand("printf exact")];
    ledger.observeChildSpawn({
      childId: "child",
      processKey: "host",
      executable: "/bin/bash",
      argv,
      cwd: "/work",
      raw: { stdio: ["ignore", 4, 4], inode: "7" },
    });
    ledger.observeChildClose("child", { args: [null, null] });
    ledger.observeHook(
      "host",
      "PostToolUse",
      { ...bashPre, hook_event_name: "PostToolUse" },
      "call",
    );
    ledger.observeProcessCapture("host", "drained", true, { observer: "joined" });
    const result = ledger.finalize([{ id: "call", name: "Bash", processKey: "host" }]);
    const serialized: unknown = JSON.parse(JSON.stringify(result));
    expect(serialized).toMatchObject({
      verdicts: [{ kind: "joined", children: [{ childId: "child", argv }] }],
      processCaptures: [
        { phase: "attached", complete: true },
        { phase: "drained", complete: true },
      ],
      childProcesses: [
        {
          childId: "child",
          evidence: { argv, raw: { inode: "7" }, closeReceipts: [{ raw: { args: [null, null] } }] },
        },
      ],
      childSpawnObservations: [
        { childId: "child", observations: [{ argv, raw: { stdio: ["ignore", 4, 4] } }] },
      ],
    });
  });
});
