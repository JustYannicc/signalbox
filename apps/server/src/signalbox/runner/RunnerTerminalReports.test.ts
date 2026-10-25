import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import type { TerminalCommand } from "@signalbox/runner-protocol/TerminalProtocol";

import { RunnerTerminalReports } from "./RunnerTerminalReports.ts";

const terminalId = "term-1";
const threadId = ThreadId.make("thread-1");

const write = (
  id: string,
  generation = 1,
  terminal = terminalId,
): Extract<TerminalCommand, { readonly type: "write" }> => ({
  type: "write",
  threadId,
  terminalId: terminal,
  generation,
  leaseGeneration: 7,
  commandId: id,
  data: "input",
});

describe("RunnerTerminalReports", () => {
  it("bounds write receipts per generation without evicting retry IDs", () => {
    const reports = new RunnerTerminalReports();

    for (let index = 0; index < 65_536; index++) {
      reports.rememberWrite(write(`write-${index}`), `digest-${index}`);
    }

    expect(reports.checkWrite(write("write-0"), "digest-0")).toBe("same");
    expect(reports.checkWrite(write("write-0"), "different-digest")).toBe("conflict");
    expect(reports.checkWrite(write("new-write"), "new-digest")).toBe("limit");
    const nextGenerationWrite = write("next-generation", 2);
    reports.rememberWrite(nextGenerationWrite, "next-digest");
    expect(reports.checkWrite(nextGenerationWrite, "next-digest")).toBe("same");
    expect(reports.checkWrite(write("other-terminal", 1, "term-2"), "other-digest")).toBe("new");

    reports.removeWrites(terminalId, 1);
    expect(reports.checkWrite(write("new-write"), "new-digest")).toBe("new");
    expect(reports.checkWrite(nextGenerationWrite, "next-digest")).toBe("same");
  });
});
