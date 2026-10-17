import { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { resolveThreadListV2Status } from "../features/threads/threadListV2";
import { threadDetailToShell } from "./thread-detail-shell";

const environmentId = EnvironmentId.make("mobile-ask-environment");
const now = "2026-10-17T12:00:00.000Z";
const ask: SignalboxAsk = {
  id: "decision",
  kind: "blocker",
  status: "pending",
  source: { kind: "agent" },
  createdAt: now,
  updatedAt: now,
  questions: [
    {
      id: "question",
      question: "Ship?",
      why: "Need your decision",
      unblocks: "Delivery",
      recommendation: "Yes",
      options: [],
      blocking: true,
      decisionOwner: "You",
      surface: { kind: "kit", component: "choice" },
    },
  ],
  rounds: [
    {
      number: 1,
      questionIds: ["question"],
      answers: [],
      deferredQuestionIds: [],
      openedAt: now,
      closedAt: null,
    },
  ],
};

describe("mobile thread detail shell attention", () => {
  it("keeps a durable blocker in the mobile needs-you state when no runtime request exists", () => {
    const shell = threadDetailToShell(environmentId, {
      ...v2Projection,
      thread: { ...v2Projection.thread, asks: [ask] },
    });
    expect(shell.asks).toEqual([ask]);
    expect(resolveThreadListV2Status(shell)).toBe("input");
  });

  it.each(["answered", "withdrawn", "archived"] as const)(
    "removes the mobile input status once the ask is %s",
    (status) => {
      const shell = threadDetailToShell(environmentId, {
        ...v2Projection,
        thread: { ...v2Projection.thread, asks: [{ ...ask, status }] },
      });
      expect(resolveThreadListV2Status(shell)).toBe("ready");
    },
  );

  it("keeps older servers without asks usable", () => {
    expect(resolveThreadListV2Status(threadDetailToShell(environmentId, v2Projection))).toBe(
      "ready",
    );
  });
});
