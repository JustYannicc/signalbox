import { expect, it } from "vite-plus/test";
import { cancelClaudeBodyQuick } from "./claudeBodyOwnership.ts";

it("retains cancellation failures and reports unresolved tee cancellation honestly", async () => {
  const cause = new Error("body cancellation failed");
  const failed = new ReadableStream<Uint8Array>({
    cancel() {
      throw cause;
    },
  });
  expect(await cancelClaudeBodyQuick(failed)).toEqual({ lifecycle: "cancel-failed", cause });
  const blocked = new ReadableStream<Uint8Array>();
  const [first, second] = blocked.tee();
  expect(await cancelClaudeBodyQuick(first)).toEqual({ lifecycle: "cancel-requested" });
  await second.cancel();
});
