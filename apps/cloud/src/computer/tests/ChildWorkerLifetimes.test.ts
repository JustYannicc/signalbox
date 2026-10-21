import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";

describe("ChildWorkerLifetimes", () => {
  it("formats every retained failure in a cause chain and aggregate before drain", async () => {
    const lifetimes = new ChildWorkerLifetimes();
    const read: string[] = [];
    const watched = (name: string, cause?: unknown) => {
      const error = new Error(name, { cause });
      const stack = error.stack;
      Object.defineProperty(error, "stack", {
        get() {
          read.push(name);
          return stack;
        },
      });
      return error;
    };
    const failure = new AggregateError(
      [watched("first"), watched("second", watched("second cause")), watched("third")],
      "cleanup failed",
      { cause: watched("aggregate cause") },
    );
    lifetimes.track(Promise.reject(failure));
    await expect(lifetimes.drain()).rejects.toBe(failure);
    expect(read.sort()).toEqual(
      ["aggregate cause", "first", "second", "second cause", "third"].sort(),
    );
  });

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

  it("formats a very large aggregate and skips an endless one", async () => {
    const lifetimes = new ChildWorkerLifetimes();
    const members = Array.from({ length: 200_000 }, () => new Error("member"));
    let lastRead = false;
    const last = members.at(-1)!;
    const stack = last.stack;
    Object.defineProperty(last, "stack", {
      get() {
        lastRead = true;
        return stack;
      },
    });
    const endless = new AggregateError([], "endless");
    Object.defineProperty(endless, "errors", {
      value: {
        *[Symbol.iterator]() {
          for (;;) yield new Error("again");
        },
      },
    });
    lifetimes.track(Promise.reject(new AggregateError(members, "large")));
    lifetimes.track(Promise.reject(endless));
    await expect(lifetimes.drain()).rejects.toMatchObject({ name: "AggregateError" });
    expect(lastRead).toBe(true);
  });
});
