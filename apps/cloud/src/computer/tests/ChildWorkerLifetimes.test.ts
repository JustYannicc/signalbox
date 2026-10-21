import { afterEach, describe, expect, it } from "vite-plus/test";
import { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";

const prepare = Error.prepareStackTrace;
afterEach(() => {
  Error.prepareStackTrace = prepare;
});

/** V8 calls prepareStackTrace when it first formats a stack, which is what frees the frames. */
function recordFormatting() {
  const formatted: string[] = [];
  Error.prepareStackTrace = (error: Error) => {
    formatted.push(error.message);
    return error.message;
  };
  return formatted;
}

describe("ChildWorkerLifetimes", () => {
  it("formats every retained failure in a cause chain and aggregate before drain", async () => {
    const formatted = recordFormatting();
    const lifetimes = new ChildWorkerLifetimes();
    const failure = new AggregateError(
      [new Error("first"), new Error("second", { cause: new Error("second cause") })],
      "aggregate",
      { cause: new Error("aggregate cause") },
    );
    lifetimes.track(Promise.reject(failure));
    await expect(lifetimes.drain()).rejects.toBe(failure);
    expect(formatted.sort()).toEqual(
      ["aggregate", "aggregate cause", "first", "second", "second cause"].sort(),
    );
  });

  it("reports hostile failures without running their getters or iterators", async () => {
    let ran = 0;
    const lifetimes = new ChildWorkerLifetimes();
    const endlessCause = new Error("endless cause");
    Object.defineProperty(endlessCause, "cause", {
      get() {
        ran++;
        return new Error("fresh");
      },
    });
    const customStack = new Error("custom stack");
    Object.defineProperty(customStack, "stack", {
      get() {
        ran++;
        return Promise.reject(new Error("rejected"));
      },
    });
    const members: unknown[] = [new Error("member")];
    Object.defineProperty(members, Symbol.iterator, {
      value: function* () {
        ran++;
        for (;;) yield new Error("again");
      },
    });
    const endlessMembers = new AggregateError([], "endless members");
    Object.defineProperty(endlessMembers, "errors", { value: members });
    for (const failure of [endlessCause, customStack, endlessMembers]) {
      lifetimes.track(Promise.reject(failure));
    }
    await expect(lifetimes.drain()).rejects.toMatchObject({
      errors: [endlessCause, customStack, endlessMembers],
    });
    expect(ran).toBe(0);
  });

  it("bounds the walk over a very large aggregate", async () => {
    const formatted = recordFormatting();
    const lifetimes = new ChildWorkerLifetimes();
    const members = Array.from({ length: 200_000 }, (_, index) => new Error(`member ${index}`));
    lifetimes.track(Promise.reject(new AggregateError(members, "large")));
    await expect(lifetimes.drain()).rejects.toMatchObject({ name: "AggregateError" });
    expect(formatted).toContain("large");
    expect(formatted).toHaveLength(1024);
  });
});
