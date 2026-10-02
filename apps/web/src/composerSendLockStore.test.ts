import { beforeEach, describe, expect, it } from "vite-plus/test";

import { isComposerSendLocked, useComposerSendLockStore } from "./composerSendLockStore";

describe("composerSendLockStore", () => {
  beforeEach(() => useComposerSendLockStore.setState({ lockedTargetKeys: {} }));

  it("locks one draft without locking the others", () => {
    useComposerSendLockStore.getState().toggleSendLocked("env:thread-1");

    expect(isComposerSendLocked("env:thread-1")).toBe(true);
    expect(isComposerSendLocked("env:thread-2")).toBe(false);
  });

  it("forgets a draft once it is unlocked", () => {
    const store = useComposerSendLockStore.getState();
    store.toggleSendLocked("env:thread-1");
    store.toggleSendLocked("env:thread-1");

    expect(isComposerSendLocked("env:thread-1")).toBe(false);
    expect(useComposerSendLockStore.getState().lockedTargetKeys).toEqual({});
  });
});
