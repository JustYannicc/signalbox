import { MessageId } from "@t3tools/contracts";
import { textRangeToSource } from "@t3tools/shared/textSourceMap";
import { describe, expect, it } from "vite-plus/test";

import { threadMessageSource } from "./thread-message-source";

describe("message presentation source ownership", () => {
  it("keeps the body after an identical phrase in a hidden schedule prefix", () => {
    const prefix = "[Triggered by schedule task: same phrase]\r\n\r\n";
    const text = `${prefix}same phrase`;
    const result = threadMessageSource({
      id: MessageId.make("scheduled-task-message:task:1:scheduled"),
      role: "user",
      text,
      createdBy: "agent",
    });
    expect(result.sourceMap.text).toBe("same phrase");
    expect(textRangeToSource(result.sourceMap, { start: 0, end: 11 })).toEqual([
      { start: prefix.length, end: text.length },
    ]);
  });

  it("keeps legacy context records out of the displayed body and retains its source offsets", () => {
    const body = "See @build:7 and same phrase";
    const text = `${body}\n<terminal_context>\n- Build line 7:\n  same phrase\n</terminal_context>`;
    const result = threadMessageSource({ id: MessageId.make("user"), role: "user", text });
    expect(result.context?.records).toHaveLength(1);
    expect(result.sourceMap.text).not.toContain("<terminal_context>");
    const phraseStart = result.sourceMap.text.length - "same phrase".length;
    expect(
      textRangeToSource(result.sourceMap, {
        start: phraseStart,
        end: result.sourceMap.text.length,
      }),
    ).toEqual([{ start: body.length - 11, end: body.length }]);
  });
});
