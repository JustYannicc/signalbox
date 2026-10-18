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

function setup(
  rejectedLimit = 20,
  unknownProjectionPolicy?: "retain" | "retire-before-confirmed-resource",
) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const sources = Atom.family((_scope: OptimisticScope) => Atom.make(initial).pipe(Atom.keepAlive));
  const source = sources(scope);
  const ledger = createOptimisticLedger<State, number, string>({
    sourceAtom: sources,
    rejectedLimit,
    ...(unknownProjectionPolicy === undefined ? {} : { unknownProjectionPolicy }),
  });
  const begin = (commandId: string, pinned: boolean, target = scope) =>
    ledger.begin(registry, {
      key: { ...target, commandId },
      project: (state) => ({ ...state, pinned }),
      confirm: (state) => state.applied.includes(commandId),
    });
  const read = (target = scope) => registry.get(ledger.snapshotAtom(target));
  const entries = (target = scope) => registry.get(ledger.entriesAtom(target));
  return { registry, source, sources, ledger, begin, read, entries };
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

  it.each(["ack-before-event", "event-before-ack"] as const)(
    "retires an earlier unknown projection on confirmed resource state (%s)",
    (order) => {
      const { begin, read, entries, registry, source, ledger } = setup(
        20,
        "retire-before-confirmed-resource",
      );
      const unknown = ledger.begin(registry, {
        key: { ...scope, commandId: "unpin" },
        actionId: "thread.unpin",
        startedAt: 123,
        project: (state) => ({ ...state, pinned: false }),
        confirm: (state) => state.applied.includes("unpin"),
      });
      unknown.acknowledge(7);
      unknown.markUnknown();

      const confirmed = begin("pin", true);
      const observed: boolean[] = [];
      const unsubscribe = registry.subscribe(ledger.snapshotAtom(scope), (state) =>
        observed.push(state.pinned),
      );
      observed.length = 0;
      if (order === "ack-before-event") confirmed.acknowledge(8);
      registry.set(source, { ...initial, pinned: true, applied: ["pin"] });
      if (order === "event-before-ack") confirmed.acknowledge(8);

      expect(read().pinned).toBe(true);
      expect(observed).not.toContain(false);
      expect(entries()).toHaveLength(1);
      expect(entries()[0]).toMatchObject({
        key: { commandId: "unpin" },
        actionId: "thread.unpin",
        startedAt: 123,
        status: "unknown",
        acknowledgment: { status: "acknowledged", receipt: 7 },
      });
      unsubscribe();
    },
  );

  it("retires an older intent that becomes unknown after the later intent is confirmed", () => {
    const { ledger, registry, source, read, entries } = setup(
      20,
      "retire-before-confirmed-resource",
    );
    const earlier = ledger.begin(registry, {
      key: { ...scope, commandId: "unpin" },
      project: (state) => ({ ...state, pinned: false }),
      confirm: (state) => state.applied.includes("unpin"),
    });
    ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("pin"),
    });

    registry.set(source, { ...initial, pinned: true, applied: ["pin"] });
    earlier.markUnknown();

    expect(entries()).toMatchObject([{ key: { commandId: "unpin" }, status: "unknown" }]);
    expect(read().pinned).toBe(true);
  });

  it.each([
    ["default", undefined, "speculative title"],
    ["retire-before-confirmed-resource", "retire-before-confirmed-resource", "server title"],
  ] as const)("uses %s behavior for an unrelated authoritative field", (_name, policy, title) => {
    const { ledger, registry, source, read, entries } = setup(20, policy);
    const unknown = ledger.begin(registry, {
      key: { ...scope, commandId: "rename" },
      actionId: "thread.rename",
      startedAt: 12,
      project: (state) => ({ ...state, title: "speculative title" }),
      confirm: (state) => state.applied.includes("rename"),
    });
    unknown.markUnknown();
    ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("pin"),
    });

    registry.set(source, {
      ...initial,
      title: "server title",
      pinned: true,
      applied: ["pin"],
    });

    expect(read().title).toBe(title);
    expect(entries()).toMatchObject([
      {
        key: { commandId: "rename" },
        actionId: "thread.rename",
        startedAt: 12,
        status: "unknown",
      },
    ]);
  });

  it("allows a later pending projection after retiring an earlier unknown one", () => {
    const { ledger, registry, source, read } = setup(20, "retire-before-confirmed-resource");
    const earlier = ledger.begin(registry, {
      key: { ...scope, commandId: "rename" },
      project: (state) => ({ ...state, title: "speculative title" }),
      confirm: (state) => state.applied.includes("rename"),
    });
    earlier.markUnknown();
    ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("pin"),
    });
    registry.set(source, { ...initial, title: "server title", pinned: true, applied: ["pin"] });

    ledger.begin(registry, {
      key: { ...scope, commandId: "later-rename" },
      project: (state) => ({ ...state, title: `${state.title}!` }),
      confirm: () => false,
    });

    expect(read()).toMatchObject({ title: "server title!", pinned: true });
  });

  it("keeps active duplicate age and gives a rejected retry a fresh age", () => {
    const { ledger, registry, source, read } = setup(20, "retire-before-confirmed-resource");
    const original = ledger.begin(registry, {
      key: { ...scope, commandId: "rename" },
      project: (state) => ({ ...state, title: "original guess" }),
      confirm: (state) => state.applied.includes("rename"),
    });
    const duplicate = ledger.begin(registry, {
      key: { ...scope, commandId: "rename" },
      project: (state) => ({ ...state, title: "duplicate guess" }),
      confirm: (state) => state.applied.includes("rename"),
    });
    ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("pin"),
    });
    registry.set(source, { ...initial, title: "server title", pinned: true, applied: ["pin"] });
    duplicate.markUnknown();
    expect(read().title).toBe("server title");
    original.cancel();

    ledger.clear(registry, scope);
    const rejected = ledger.begin(registry, {
      key: { ...scope, commandId: "retry" },
      project: (state) => ({ ...state, title: "rejected guess" }),
      confirm: (state) => state.applied.includes("retry"),
    });
    rejected.reject("Retry");
    ledger.begin(registry, {
      key: { ...scope, commandId: "later-pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("later-pin"),
    });
    registry.set(source, {
      ...initial,
      title: "server title",
      pinned: true,
      applied: ["later-pin"],
    });
    const retry = ledger.begin(registry, {
      key: { ...scope, commandId: "retry" },
      project: (state) => ({ ...state, title: "fresh retry guess" }),
      confirm: (state) => state.applied.includes("retry"),
    });
    retry.markUnknown();

    expect(read().title).toBe("fresh retry guess");
  });

  it("does not retire an unknown projection for an acknowledgment or unrelated revision", () => {
    const { ledger, registry, source, read, entries } = setup(
      20,
      "retire-before-confirmed-resource",
    );
    const unknown = ledger.begin(registry, {
      key: { ...scope, commandId: "rename" },
      project: (state) => ({ ...state, title: "speculative title" }),
      confirm: (state) => state.applied.includes("rename"),
    });
    unknown.markUnknown();
    const unconfirmed = ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("pin"),
    });
    unconfirmed.acknowledge(4);
    registry.set(source, { ...initial, title: "server title", revision: 9000, applied: ["other"] });

    expect(read().title).toBe("speculative title");
    expect(entries().map((entry) => [entry.key.commandId, entry.status])).toEqual([
      ["rename", "unknown"],
      ["pin", "confirming"],
    ]);
  });

  it("shows a late authoritative event after its retired unknown projection", () => {
    const { ledger, registry, source, read, entries } = setup(
      20,
      "retire-before-confirmed-resource",
    );
    const lateIntent = ledger.begin(registry, {
      key: { ...scope, commandId: "rename" },
      project: (state) => ({ ...state, title: "speculative title" }),
      confirm: (state) => state.applied.includes("rename"),
    });
    lateIntent.markUnknown();
    ledger.begin(registry, {
      key: { ...scope, commandId: "pin" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("pin"),
    });
    registry.set(source, { ...initial, title: "server title", pinned: true, applied: ["pin"] });
    expect(read().title).toBe("server title");
    expect(entries()).toMatchObject([{ key: { commandId: "rename" }, status: "unknown" }]);

    lateIntent.acknowledge(9);
    expect(read().title).toBe("server title");
    expect(entries()).toMatchObject([
      {
        key: { commandId: "rename" },
        status: "confirming",
        acknowledgment: { status: "acknowledged", receipt: 9 },
      },
    ]);

    registry.set(source, {
      ...initial,
      title: "late authoritative title",
      pinned: false,
      applied: ["pin", "rename"],
    });

    expect(read().title).toBe("late authoritative title");
    expect(read().pinned).toBe(false);
    expect(entries()).toEqual([]);
  });

  it("isolates confirmation cutoffs by scope and registry and resets them on clear", () => {
    const { begin, entries, ledger, read, registry, sources } = setup(
      20,
      "retire-before-confirmed-resource",
    );
    const unknown = ledger.begin(registry, {
      key: { ...scope, commandId: "rename" },
      project: (state) => ({ ...state, title: "speculative title" }),
      confirm: (state) => state.applied.includes("rename"),
    });

    for (const [index, other] of [
      { ...scope, accountId: "bob" },
      { ...scope, environmentId: "other-cloud" },
      { ...scope, resourceId: "another-thread" },
    ].entries()) {
      ledger.begin(registry, {
        key: { ...other, commandId: `confirm-${index}` },
        project: (state) => ({ ...state, pinned: true }),
        confirm: (state) => state.applied.includes(`confirm-${index}`),
      });
      registry.set(sources(other), { ...initial, pinned: true, applied: [`confirm-${index}`] });
    }
    expect(read().pinned).toBe(false);
    expect(entries()[0]?.status).toBe("pending");

    const otherRegistry = AtomRegistry.make();
    registries.push(otherRegistry);
    ledger.begin(otherRegistry, {
      key: { ...scope, commandId: "other-registry" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("other-registry"),
    });
    otherRegistry.set(sources(scope), {
      ...initial,
      pinned: true,
      applied: ["other-registry"],
    });
    unknown.markUnknown();
    expect(read().title).toBe("speculative title");
    expect(entries()[0]?.status).toBe("unknown");

    ledger.begin(registry, {
      key: { ...scope, commandId: "confirmed-before-clear" },
      project: (state) => ({ ...state, pinned: true }),
      confirm: (state) => state.applied.includes("confirmed-before-clear"),
    });
    registry.set(sources(scope), {
      ...initial,
      pinned: true,
      applied: ["confirmed-before-clear"],
    });
    expect(read().pinned).toBe(true);

    const stale = begin("reuse", true);
    ledger.clear(registry, scope);
    const fresh = begin("reuse", false);
    stale.acknowledge(9);
    stale.markUnknown();
    stale.reject("late rejection");
    stale.cancel();
    expect(entries()).toMatchObject([{ key: { commandId: "reuse" }, status: "pending" }]);
    expect(read().pinned).toBe(false);
    fresh.cancel();
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
