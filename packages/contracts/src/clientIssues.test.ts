import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ClientIssue } from "@t3tools/contracts/clientIssues";

const decode = Schema.decodeUnknownOption(ClientIssue);
const issue = {
  code: "rpc.failed",
  severity: "error",
  source: "rpc",
  client: "web",
  release: "eb49bb177c05cbd3fd2ec624b53cf0cdd85bab15",
  threadId: "cb3f29a1-cf74-412e-91e4-9bc47851a8d6",
  folderId: null,
  environmentId: null,
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
};

describe("content-free client issue contract", () => {
  it("reconstructs an event without exception, message or file content", () => {
    const canary = "private-message-and-file-content";
    const event = decode({
      ...issue,
      message: canary,
      content: canary,
      cause: { stack: canary, file: canary },
    });
    expect(Option.isSome(event)).toBe(true);
    if (Option.isSome(event)) {
      expect(event.value.traceId).toBe(issue.traceId);
      expect(event.value.threadId).toBe(issue.threadId);
      expect(JSON.stringify(event.value)).not.toContain(canary);
    }
  });

  it("refuses content disguised as a code, context id or release", () => {
    for (const field of ["code", "threadId", "folderId", "release"]) {
      expect(Option.isNone(decode({ ...issue, [field]: "private_message_content" }))).toBe(true);
    }
    expect(Option.isNone(decode({ ...issue, traceId: "0".repeat(32) }))).toBe(true);
    expect(Option.isNone(decode({ ...issue, spanId: "0".repeat(16) }))).toBe(true);
  });
});
