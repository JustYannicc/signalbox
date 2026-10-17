import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent, reuseUnchangedThreadShells } from "./shellReducer.ts";
import { isThreadWorking } from "./threadInbox.ts";
import {
  createEnvironmentThreadShellAtoms,
  pendingSubagentRequestsByThread,
} from "./threadShell.ts";
import { canSnooze, effectiveSnoozed } from "./threadSettled.ts";

const environmentId = EnvironmentId.make("ask-environment");
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
      why: "Needs your decision",
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

describe("durable ask shell attention", () => {
  it("keeps a completed thread needing input and wakes its snoozed row", () => {
    const thread = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      status: "completed",
      asks: [ask],
    });
    expect(thread.hasPendingUserInput).toBe(true);
    expect(thread.asks).toEqual([ask]);
    expect(isThreadWorking(thread)).toBe(false);
    expect(canSnooze(thread, { now })).toBe(false);
    expect(effectiveSnoozed({ ...thread, snoozedUntil: "2026-10-18T12:00:00.000Z" }, { now })).toBe(
      false,
    );
  });

  it.each([
    { ...ask, kind: "ready" },
    { ...ask, kind: "considering" },
    { ...ask, status: "answered" },
    { ...ask, status: "withdrawn" },
    { ...ask, status: "archived" },
    { ...ask, questions: [{ ...ask.questions[0], blocking: false }] },
    { ...ask, rounds: [{ ...ask.rounds[0], questionIds: [] }] },
  ] satisfies SignalboxAsk[])(
    "does not raise needs-you for $kind/$status without a pending blocker",
    (candidate) => {
      expect(
        presentThreadShell(environmentId, { ...v2ThreadShell, asks: [candidate] })
          .hasPendingUserInput,
      ).toBe(false);
    },
  );

  it("still shows live runtime input on older servers with no asks", () => {
    expect(
      presentThreadShell(environmentId, {
        ...v2ThreadShell,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("live-question"),
          kind: "user_input",
          createdAt: v2Now,
        },
      }).hasPendingUserInput,
    ).toBe(true);
    expect(presentThreadShell(environmentId, v2ThreadShell).hasPendingUserInput).toBe(false);
  });

  it("does not show a linked non-blocking native question as needs-you", () => {
    const requestId = RuntimeRequestId.make("async-question");
    const nativeAsk: SignalboxAsk = {
      ...ask,
      id: "async-question-ask",
      source: { kind: "native", requestId },
      questions: [{ ...ask.questions[0]!, blocking: false }],
    };
    expect(
      presentThreadShell(environmentId, {
        ...v2ThreadShell,
        pendingRuntimeRequest: {
          id: requestId,
          kind: "user_input",
          createdAt: v2Now,
        },
        asks: [nativeAsk],
      }).hasPendingUserInput,
    ).toBe(false);
  });

  it("keeps needs-you when the linked native question blocks work", () => {
    const requestId = RuntimeRequestId.make("blocking-question");
    const nativeAsk: SignalboxAsk = {
      ...ask,
      id: "blocking-question-ask",
      source: { kind: "native", requestId },
    };
    expect(
      presentThreadShell(environmentId, {
        ...v2ThreadShell,
        pendingRuntimeRequest: {
          id: requestId,
          kind: "user_input",
          createdAt: v2Now,
        },
        asks: [nativeAsk],
      }).hasPendingUserInput,
    ).toBe(true);
  });

  it("updates the navigation row on ask-only deltas and clears it when answered", () => {
    const registry = AtomRegistry.make();
    const snapshotAtom = Atom.make(v2ShellSnapshot);
    const threads = createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
      snapshotAtom: () => snapshotAtom,
    });
    const rowAtom = threads.threadShellAtom({ environmentId, threadId: v2ThreadShell.id });
    const unmount = registry.mount(rowAtom);
    try {
      expect(registry.get(rowAtom)?.hasPendingUserInput).toBe(false);
      const raised = applyShellStreamEvent(v2ShellSnapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: { ...v2ThreadShell, asks: [ask] },
      });
      registry.set(snapshotAtom, raised);
      expect(registry.get(rowAtom)?.hasPendingUserInput).toBe(true);
      const answered = reuseUnchangedThreadShells(raised, {
        ...raised,
        snapshotSequence: 2,
        threads: [{ ...v2ThreadShell, asks: [{ ...ask, status: "answered" }] }],
      });
      registry.set(snapshotAtom, answered);
      expect(registry.get(rowAtom)?.hasPendingUserInput).toBe(false);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("keeps a hidden subagent's durable blocker on its parent after the child turn ends", () => {
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("child"),
      creationSource: "mcp" as const,
      status: "completed" as const,
      activityRunStatus: null,
      asks: [ask],
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: v2ThreadShell.id,
        relationshipToParent: "subagent" as const,
      },
    };
    expect(pendingSubagentRequestsByThread([v2ThreadShell, child]).get(v2ThreadShell.id)).toBe(
      "user_input",
    );
    expect(
      pendingSubagentRequestsByThread([
        v2ThreadShell,
        { ...child, asks: [{ ...ask, status: "answered" }] },
      ]).has(v2ThreadShell.id),
    ).toBe(false);
    expect(
      pendingSubagentRequestsByThread([
        v2ThreadShell,
        { ...child, asks: [{ ...ask, kind: "ready" }] },
      ]).has(v2ThreadShell.id),
    ).toBe(false);
  });
});
