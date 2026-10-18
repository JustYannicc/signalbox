import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createOpenedTerminalGenerations,
  forgetTerminalGenerationAfterClose,
  rememberOpenedTerminalGeneration,
  selectTerminalGeneration,
} from "./terminalGenerations";

const threadRef = (environmentId: string, threadId: string) =>
  scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));

describe("terminal generation selection", () => {
  it("keeps the just-opened generation while the known session list lags", () => {
    const generations = createOpenedTerminalGenerations();
    const ref = threadRef("env-1", "thread-1");
    rememberOpenedTerminalGeneration(generations, ref, "terminal-1", 4);

    expect(
      selectTerminalGeneration(generations, {
        threadRef: ref,
        terminalId: "terminal-1",
        sessions: [{ target: { terminalId: "terminal-1" }, state: { generation: 3 } }],
        preferOpenedSnapshot: true,
      }),
    ).toBe(4);
  });

  it("uses a newer known generation after the terminal restarts", () => {
    const generations = createOpenedTerminalGenerations();
    const ref = threadRef("env-1", "thread-1");
    rememberOpenedTerminalGeneration(generations, ref, "terminal-1", 4);

    expect(
      selectTerminalGeneration(generations, {
        threadRef: ref,
        terminalId: "terminal-1",
        sessions: [{ target: { terminalId: "terminal-1" }, state: { generation: 5 } }],
        preferOpenedSnapshot: true,
      }),
    ).toBe(5);
  });

  it("keeps opened generations isolated by environment and thread", () => {
    const generations = createOpenedTerminalGenerations();
    const firstThread = threadRef("env-1", "thread-1");
    rememberOpenedTerminalGeneration(generations, firstThread, "terminal-1", 4);

    for (const otherThread of [
      threadRef("env-1", "thread-2"),
      threadRef("env-2", "thread-1"),
      threadRef("env:with-colon", "thread"),
      threadRef("env", "with-colon:thread"),
    ]) {
      expect(
        selectTerminalGeneration(generations, {
          threadRef: otherThread,
          terminalId: "terminal-1",
          sessions: null,
          preferOpenedSnapshot: true,
        }),
      ).toBeUndefined();
    }
  });

  it("forgets only the selected thread's generation after a successful close", () => {
    const generations = createOpenedTerminalGenerations();
    const firstThread = threadRef("env-1", "thread-1");
    const secondThread = threadRef("env-2", "thread-1");
    rememberOpenedTerminalGeneration(generations, firstThread, "terminal-1", 4);
    rememberOpenedTerminalGeneration(generations, secondThread, "terminal-1", 8);

    forgetTerminalGenerationAfterClose(generations, firstThread, "terminal-1", "Failure");
    expect(
      selectTerminalGeneration(generations, {
        threadRef: firstThread,
        terminalId: "terminal-1",
        sessions: null,
      }),
    ).toBe(4);

    forgetTerminalGenerationAfterClose(generations, firstThread, "terminal-1", "Success");

    expect(
      selectTerminalGeneration(generations, {
        threadRef: firstThread,
        terminalId: "terminal-1",
        sessions: null,
      }),
    ).toBeUndefined();
    expect(
      selectTerminalGeneration(generations, {
        threadRef: secondThread,
        terminalId: "terminal-1",
        sessions: null,
      }),
    ).toBe(8);
  });

  it("does not replace an opened snapshot with an out-of-order older open", () => {
    const generations = createOpenedTerminalGenerations();
    const ref = threadRef("env-1", "thread-1");
    rememberOpenedTerminalGeneration(generations, ref, "terminal-1", 5);
    rememberOpenedTerminalGeneration(generations, ref, "terminal-1", 4);

    expect(
      selectTerminalGeneration(generations, {
        threadRef: ref,
        terminalId: "terminal-1",
        sessions: null,
        preferOpenedSnapshot: true,
      }),
    ).toBe(5);
  });
});
