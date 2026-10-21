import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";

describe("ChildWorkerLifetimes", () => {
  it("still reports a failure whose stack, cause and members cannot be read", async () => {
    const lifetimes = new ChildWorkerLifetimes();
    const hostile = new Error("cleanup failed");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("unreadable stack");
      },
    });
    const nested = new AggregateError([hostile, new Error("inner")], "outer");
    Object.defineProperty(nested, "cause", {
      get() {
        throw new Error("unreadable cause");
      },
    });
    lifetimes.track(Promise.reject(hostile));
    lifetimes.track(Promise.reject(nested));

    await expect(lifetimes.drain()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [hostile, nested],
    });
  });
});
