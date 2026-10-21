import { describe, expect, it } from "vite-plus/test";
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
});
