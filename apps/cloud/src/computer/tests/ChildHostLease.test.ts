import { describe, expect, it, vi } from "vite-plus/test";
import { ChildHostLease } from "../ChildHostLease.ts";

describe("child host lease", () => {
  it("drops one finished ref early and every ref on release, including ones held after it", () => {
    const lease = new ChildHostLease();
    const root = lease.hold({ name: "root" });
    const finished = lease.hold({ name: "finished" });
    lease.drop(finished);
    expect(root.get()).toEqual({ name: "root" });
    expect(() => finished.get()).toThrow(expect.objectContaining({ code: "EBADF" }));

    lease.release();
    const late = lease.hold({ name: "late" });
    for (const ref of [root, late]) {
      expect(() => ref.get()).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
  });

  it("revokes every ref even when one disposer throws", () => {
    const lease = new ChildHostLease();
    const failure = new Error("source dispose failed");
    const first = lease.hold({ name: "first" }, () => {
      throw failure;
    });
    const secondDispose = vi.fn();
    const second = lease.hold({ name: "second" }, secondDispose);

    expect(() => lease.release()).toThrow(failure);
    expect(secondDispose).toHaveBeenCalledOnce();
    for (const ref of [first, second]) {
      expect(() => ref.get()).toThrow(expect.objectContaining({ code: "EBADF" }));
    }

    const late = lease.hold({ name: "late" });
    expect(() => late.get()).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
});
