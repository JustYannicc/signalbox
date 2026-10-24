import { describe, expect, it } from "@effect/vitest";
import { failureOf, HarnessDurableStateError } from "../HarnessDurableState.ts";

describe("harness durable state errors", () => {
  it("keeps arbitrary failure text only as an error cause", () => {
    const cause = new Error("/private/tmp/storage-token.txt");
    const error = new HarnessDurableStateError({ code: "STORAGE", cause });

    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(cause.message);
    expect(failureOf(cause)).toEqual({
      code: "STORAGE",
      message: "Durable state storage failed.",
    });
  });
});
