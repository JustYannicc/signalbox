import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createOptimisticLedger, type OptimisticScope } from "./optimisticLedger.ts";

const scope: OptimisticScope = { accountId: "alice", environmentId: "cloud", resourceId: "thread" };
interface State {
  readonly pinned: boolean;
  readonly title: string;
  readonly applied: ReadonlyArray<string>;
  readonly revision: number;
}
const initial: State = { pinned: false, title: "before", applied: [], revision: 0 };
const registries: AtomRegistry.AtomRegistry[] = [];

function setup(rejectedLimit = 20) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const sources = Atom.family((_scope: OptimisticScope) => Atom.make(initial).pipe(Atom.keepAlive));
  const source = sources(scope);
  const ledger = createOptimisticLedger<State, number, string>({
    sourceAtom: sources,
    rejectedLimit,
  });
  const begin = (commandId: string, pinned: boolean, target = scope) =>
    ledger.begin(registry, {
      key: { ...target, commandId },
      project: (state) => ({ ...state, pinned }),
      confirm: (state) => state.applied.includes(commandId),
    });
  const read = () => registry.get(ledger.snapshotAtom(scope));
  const entries = () => registry.get(ledger.entriesAtom(scope));
  return { registry, source, ledger, begin, read, entries };
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe("optimistic ledger", () => {
  it("projects before the caller starts asynchronous work and leaves the source untouched", () => {
    const { begin, read, registry, source, ledger } = setup();
    begin("pin", true);
    expect(read().pinned).toBe(true);
    expect(registry.get(source)).toBe(initial);
    expect(registry.get(ledger.entriesAtom(scope, "pending"))).toHaveLength(1);
  });

  it("rebases later intent on current authoritative data after an older rejection", () => {
    const { begin, read, registry, source, entries, ledger } = setup();
    const older = begin("pin", true);
    begin("unpin", false);
    registry.set(source, { ...initial, title: "edited elsewhere", revision: 1000 });
    older.reject("Pinning is disabled. Ask the folder owner for access.");
    expect(read()).toEqual({ ...initial, title: "edited elsewhere", revision: 1000 });
    expect(entries().map((entry) => entry.status)).toEqual(["rejected", "pending"]);
    expect(registry.get(ledger.entriesAtom(scope, "rejected"))[0]).toMatchObject({
      cause: "Pinning is disabled. Ask the folder owner for access.",
    });
  });

  it("replays noncommutative projections in begin order over the newest source", () => {
    const { ledger, registry, source, read } = setup();
    const first = ledger.begin(registry, {
      key: { ...scope, commandId: "first" },
      project: (state) => ({ ...state, title: state.title + "!" }),
      confirm: () => false,
    });
    ledger.begin(registry, {
      key: { ...scope, commandId: "second" },
      project: (state) => ({ ...state, title: `[${state.title}]` }),
      confirm: () => false,
    });
    expect(read().title).toBe("[before!]");
    registry.set(source, { ...initial, title: "new" });
    first.reject("Rejected");
    expect(read().title).toBe("[new]");
  });

  it("does not treat an ack or an unrelated global revision as confirmation", () => {
    const { begin, read, entries, registry, source, ledger } = setup();
    begin("pin", true).acknowledge(2);
    registry.set(source, { ...initial, revision: 9999, applied: ["another-command"] });
    expect(read().pinned).toBe(true);
    expect(registry.get(ledger.entriesAtom(scope, "confirming"))).toHaveLength(1);
    registry.set(source, { ...initial, pinned: true, applied: ["pin"] });
    expect(entries()).toEqual([]);
    expect(read().pinned).toBe(true);
  });

  it("handles event-before-ack without resurrecting a confirmed operation", () => {
    const { begin, entries, registry, source, read } = setup();
    const handle = begin("pin", true);
    registry.set(source, { ...initial, pinned: true, applied: ["pin"] });
    expect(entries()).toEqual([]);
    handle.acknowledge(10);
    handle.markUnknown();
    handle.reject("late failure");
    expect(entries()).toEqual([]);
    expect(read().pinned).toBe(true);
  });

  it("does not publish a projection twice when its authoritative event arrives", () => {
    const { ledger, registry, source } = setup();
    const observed: string[] = [];
    const unsubscribe = registry.subscribe(ledger.snapshotAtom(scope), (state) =>
      observed.push(state.title),
    );
    ledger.begin(registry, {
      key: { ...scope, commandId: "append" },
      project: (state) => ({ ...state, title: state.title + "!" }),
      confirm: (state) => state.applied.includes("append"),
    });
    registry.set(source, { ...initial, title: "before!", applied: ["append"] });
    expect(observed).not.toContain("before!!");
    expect(registry.get(ledger.snapshotAtom(scope)).title).toBe("before!");
    unsubscribe();
  });

  it("checks an already received event when a receipt arrives later", () => {
    const { ledger, registry, source, entries } = setup();
    const handle = ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state, ack) =>
        ack.status === "acknowledged" && state.applied.includes(`receipt:${ack.receipt}`),
    });
    registry.set(source, { ...initial, pinned: true, applied: ["receipt:7"] });
    expect(entries()[0]?.status).toBe("pending");
    handle.acknowledge(7);
    expect(entries()).toEqual([]);
  });

  it("retains an unknown outcome until an authoritative event resolves it", () => {
    const { begin, read, ledger, registry, source, entries } = setup();
    begin("pin", true).markUnknown();
    expect(read().pinned).toBe(true);
    expect(registry.get(ledger.entriesAtom(scope, "unknown"))).toHaveLength(1);
    registry.set(source, { ...initial, pinned: true, applied: ["pin"] });
    expect(entries()).toEqual([]);
  });

  it("isolates accounts, environments, resources and registries", () => {
    const { begin, ledger, registry } = setup();
    begin("same-command", true);
    for (const other of [
      { ...scope, accountId: "bob" },
      { ...scope, environmentId: "other-cloud" },
      { ...scope, resourceId: "another-thread" },
    ]) {
      expect(registry.get(ledger.snapshotAtom(other)).pinned).toBe(false);
      begin("same-command", true, other).reject("Denied");
    }
    expect(registry.get(ledger.snapshotAtom(scope)).pinned).toBe(true);
    const second = AtomRegistry.make();
    registries.push(second);
    expect(second.get(ledger.snapshotAtom(scope)).pinned).toBe(false);
  });

  it("deduplicates a stable command ID and ignores handles from a cleared scope", () => {
    const { begin, entries, ledger, registry, read } = setup();
    const stale = begin("pin", true);
    begin("pin", false);
    expect(entries()).toHaveLength(1);
    expect(read().pinned).toBe(true);
    ledger.clear(registry, scope);
    begin("pin", false);
    stale.reject("Old failure");
    stale.cancel();
    stale.acknowledge(1);
    expect(entries()[0]?.status).toBe("pending");
    expect(read().pinned).toBe(false);
  });

  it("retries a rejected command as a fresh intent in begin order", () => {
    const { ledger, registry, source, entries, read } = setup();
    const original = ledger.begin(registry, {
      key: { ...scope, commandId: "save" },
      actionId: "save.original",
      startedAt: 10,
      project: (state) => ({ ...state, title: `${state.title} original` }),
      confirm: (state) => state.applied.includes("save"),
    });
    original.reject("Try again");

    ledger.begin(registry, {
      key: { ...scope, commandId: "later" },
      project: (state) => ({ ...state, title: `${state.title} later` }),
      confirm: (state) => state.applied.includes("later"),
    });
    const retry = ledger.begin(registry, {
      key: { ...scope, commandId: "save" },
      actionId: "save.retry",
      startedAt: 20,
      project: (state) => ({ ...state, title: `[${state.title}]` }),
      confirm: (state) => state.applied.includes("save"),
    });

    expect(read().title).toBe("[before later]");
    expect(entries().map((entry) => [entry.key.commandId, entry.status])).toEqual([
      ["later", "pending"],
      ["save", "pending"],
    ]);
    expect(registry.get(ledger.entriesAtom(scope, "rejected"))).toEqual([]);
    expect(entries()[1]).toMatchObject({
      actionId: "save.retry",
      startedAt: 20,
      acknowledgment: { status: "pending" },
    });

    original.acknowledge(99);
    original.markUnknown();
    original.reject("Late failure from original attempt");
    original.cancel();

    expect(entries()[1]).toMatchObject({
      actionId: "save.retry",
      startedAt: 20,
      status: "pending",
      acknowledgment: { status: "pending" },
    });
    expect(entries()).toHaveLength(2);
    expect(registry.get(ledger.entriesAtom(scope, "rejected"))).toEqual([]);
    expect(read().title).toBe("[before later]");

    retry.acknowledge(21);
    expect(entries()[1]).toMatchObject({ status: "confirming", startedAt: 20 });
    registry.set(source, {
      ...initial,
      title: "[before later]",
      applied: ["save", "later"],
    });
    expect(entries()).toEqual([]);
  });

  it("bounds rejected retention without evicting active work and lets callers dismiss errors", () => {
    const { begin, entries, read } = setup(2);
    begin("active", true);
    begin("one", false).reject("one");
    begin("two", false).reject("two");
    const latest = begin("three", false);
    latest.reject("three");
    expect(entries().map((entry) => entry.key.commandId)).toEqual(["active", "two", "three"]);
    expect(read().pinned).toBe(true);
    latest.cancel();
    expect(entries().map((entry) => entry.key.commandId)).toEqual(["active", "two"]);
  });

  it("preserves action metadata through acknowledgment, uncertainty and rejection", () => {
    const { ledger, registry, entries } = setup();
    const metadata = { actionId: "thread.pin", startedAt: 1234 };
    const handle = ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      ...metadata,
      project: (state) => ({ ...state, pinned: true }),
      confirm: () => false,
    });
    expect(entries()[0]).toMatchObject({ ...metadata, status: "pending" });
    handle.acknowledge(7);
    expect(entries()[0]).toMatchObject({ ...metadata, status: "confirming" });
    handle.markUnknown();
    expect(entries()[0]).toMatchObject({ ...metadata, status: "unknown" });
    handle.reject("Access revoked");
    expect(registry.get(ledger.entriesAtom(scope, "rejected"))[0]).toMatchObject({
      ...metadata,
      cause: "Access revoked",
      acknowledgment: { status: "acknowledged", receipt: 7 },
    });
  });

  it("dismisses a rejection by its full key without the original handle", () => {
    const { ledger, registry, begin, entries } = setup();
    begin("pin", true).reject("Denied");
    begin("other", false).reject("Another failure");
    const otherScopes = [
      { ...scope, accountId: "bob" },
      { ...scope, environmentId: "other-cloud" },
      { ...scope, resourceId: "another-thread" },
    ];
    for (const other of otherScopes) begin("pin", true, other).reject("Unrelated failure");
    const rejected = registry.get(ledger.entriesAtom(scope, "rejected"))[0]!;
    ledger.dismissRejection(registry, rejected.key);
    expect(entries().map((entry) => entry.key.commandId)).toEqual(["other"]);
    for (const other of otherScopes) {
      expect(registry.get(ledger.entriesAtom(other, "rejected"))).toHaveLength(1);
    }
  });

  it.each(["pending", "confirming", "unknown"] as const)(
    "cannot dismiss a %s intent as a rejection",
    (status) => {
      const { ledger, registry, begin, entries, read } = setup();
      const handle = begin("pin", true);
      if (status === "confirming") handle.acknowledge(1);
      if (status === "unknown") handle.markUnknown();
      ledger.dismissRejection(registry, { ...scope, commandId: "pin" });
      expect(entries()).toHaveLength(1);
      expect(entries()[0]?.status).toBe(status);
      expect(read().pinned).toBe(true);
      handle.cancel();
      expect(entries()).toEqual([]);
    },
  );

  it.each(["confirm", "reject", "cancel", "clear"] as const)(
    "releases its shared source subscription after %s",
    (outcome) => {
      const { begin, registry, ledger, source } = setup();
      const subscribe = registry.subscribe.bind(registry);
      const release = vi.fn();
      const spy = vi.spyOn(registry, "subscribe").mockImplementation((atom, listener, options) => {
        const unsubscribe = subscribe(atom, listener, options);
        return () => {
          release();
          unsubscribe();
        };
      });
      const first = begin("first", true);
      const second = begin("second", false);
      expect(spy).toHaveBeenCalledTimes(1);
      first.cancel();
      expect(release).not.toHaveBeenCalled();
      if (outcome === "confirm") registry.set(source, { ...initial, applied: ["second"] });
      if (outcome === "reject") second.reject("Denied");
      if (outcome === "cancel") second.cancel();
      if (outcome === "clear") ledger.clear(registry, scope);
      expect(release).toHaveBeenCalledTimes(1);
      begin("third", true);
      expect(spy).toHaveBeenCalledTimes(2);
      ledger.clear(registry, scope);
      expect(release).toHaveBeenCalledTimes(2);
    },
  );
});
