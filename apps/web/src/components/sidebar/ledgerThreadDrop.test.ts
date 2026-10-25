import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => [] as { title: string }[]);
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: { title: string }) => toast,
  toastManager: { add: (toast: { title: string }) => toasts.push(toast) },
}));

import { beginLedgerThreadDrop } from "./ledgerThreadDrop";

const environmentId = EnvironmentId.make("primary");
const moved = { environmentId, id: ThreadId.make("moved") };
const other = { environmentId, id: ThreadId.make("other") };
const threadByKey = new Map([
  ["moved", moved],
  ["other", other],
]);
const threadRef = scopeThreadRef(environmentId, moved.id);

function harness() {
  const calls: string[] = [];
  const pending: Promise<unknown>[] = [];
  let release!: (fail: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const command =
    (name: string) =>
    (ref: { threadId: string }, ..._rest: unknown[]) => {
      calls.push(`${name}:${ref.threadId}`);
      const result = gate.then((fail) =>
        fail
          ? AsyncResult.failure(Cause.fail(new Error(`${name} failed`)))
          : AsyncResult.success(undefined),
      );
      pending.push(result);
      return result;
    };
  const actions = {
    pinThread: command("pin"),
    unpinThread: command("unpin"),
    unsettleThread: command("unsettle"),
    unsnoozeThread: command("unsnooze"),
    reorderPinnedThread: command("reorderPin"),
    reorderActiveThread: command("reorderActive"),
  };
  return {
    calls,
    actions,
    async finish(fail: boolean) {
      release(fail);
      await Promise.all(pending);
    },
  };
}

beforeEach(() => {
  toasts.length = 0;
});

describe("beginLedgerThreadDrop", () => {
  it("begins the pin and every key write before any settles", async () => {
    const { calls, finish, actions } = harness();
    const handled = beginLedgerThreadDrop({
      plan: {
        kind: "pin",
        order: ["moved", "other"],
        orderKey: "a",
        extraAssignments: [{ id: "other", orderKey: "b" }],
      },
      threadRef,
      threadByKey,
      actions,
    });
    expect(handled).toBe(true);
    expect(calls).toEqual(["pin:moved", "reorderPin:other"]);
    await finish(false);
    expect(toasts).toEqual([]);
  });

  it("starts an unpin with its follow-ons and reports only the first failure", async () => {
    const { calls, finish, actions } = harness();
    beginLedgerThreadDrop({
      plan: {
        kind: "move-active",
        order: ["moved", "other"],
        assignments: [{ id: "moved", orderKey: "m" }],
        unpin: true,
        unsettle: false,
        unsnooze: true,
      },
      threadRef,
      threadByKey,
      actions,
    });
    expect(calls).toEqual(["unpin:moved", "unsnooze:moved", "reorderActive:moved"]);
    await finish(true);
    expect(toasts.map(({ title }) => title)).toEqual(["Failed to unpin thread"]);
  });

  it("leaves settle and active-only moves to the sidebar", () => {
    const { calls, actions } = harness();
    for (const plan of [
      { kind: "settle" },
      {
        kind: "move-active",
        order: null,
        assignments: [],
        unpin: false,
        unsettle: true,
        unsnooze: false,
      },
    ] as const) {
      expect(beginLedgerThreadDrop({ plan, threadRef, threadByKey, actions })).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});
