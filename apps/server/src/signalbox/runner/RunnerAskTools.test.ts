import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { serve } from "./RunnerAutomationTools.testkit.ts";

describe("cloud agent ask tools", () => {
  it.effect(
    "raises an open question through the authenticated cloud transport and reads it later",
    () =>
      Effect.gen(function* () {
        const { cloud, call } = yield* serve({
          respond: (request) => ({
            _tag: "ok",
            result:
              request.name === "t3_ask_raise"
                ? { askId: "ask-1", round: 1, sequence: 4 }
                : { asks: [] },
          }),
        });
        const raised = yield* call("t3_ask_raise", {
          clientRequestId: "need-font",
          kind: "blocker",
          questions: [
            {
              id: "font",
              question: "Which font?",
              why: "The document needs a font.",
              unblocks: "Exporting the document.",
              recommendation: "serif",
              options: [],
              blocking: false,
              decisionOwner: "Yannic",
              surface: { kind: "kit", component: "text" },
            },
          ],
        });
        expect(raised.isError).not.toBe(true);
        expect(cloud.requests[0]?.name).toBe("t3_ask_raise");
        yield* call("t3_ask_list", {});
        expect(cloud.requests.map((request) => request.name)).toEqual([
          "t3_ask_raise",
          "t3_ask_list",
        ]);
      }).pipe(Effect.scoped),
  );
});
