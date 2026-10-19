import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { nativeTimingRecord, nativeTimingRow } from "./ModelProofTimingProjection.mjs";

NodeTest.test("stores allowlisted native timings and drops trace payloads", () => {
  const row = nativeTimingRecord(
    {
      eventTimestamp: 1_776_000_000_123,
      cpuTime: 42,
      wallTime: 55,
      outcome: "ok",
      executionModel: "stateless",
      truncated: false,
      event: {
        request: {
          url: "https://private.invalid/turn?secret=query-secret",
          headers: { authorization: "header-secret" },
          body: "body-secret",
        },
      },
      console: [{ message: "console-secret" }],
      exception: { message: "exception-secret" },
    },
    { traceId: "0123456789abcdef", layer: "facet" },
  );
  const serialized = JSON.stringify(row);

  NodeAssert.deepEqual(row, {
    traceId: "0123456789abcdef",
    layer: "facet",
    phase: "/turn",
    eventTimestamp: 1_776_000_000_123,
    cpuTime: 42,
    wallTime: 55,
    outcome: "ok",
    executionModel: "stateless",
    truncated: false,
  });
  for (const privateMarker of [
    "private.invalid",
    "query-secret",
    "header-secret",
    "body-secret",
    "console-secret",
    "exception-secret",
  ]) {
    NodeAssert.equal(serialized.includes(privateMarker), false);
  }
});

NodeTest.test("uses only known phases and finite nonnegative native values", () => {
  const row = nativeTimingRecord(
    {
      eventTimestamp: Infinity,
      cpuTime: -1,
      wallTime: NaN,
      outcome: "private-outcome",
      executionModel: "private-model",
      truncated: "true",
      event: { request: { url: "https://private.invalid/unknown?secret=x" } },
    },
    { traceId: "not-a-run-id", layer: "child" },
  );

  NodeAssert.deepEqual(row, {
    traceId: "unclassified",
    layer: "other",
    phase: "other",
    eventTimestamp: null,
    cpuTime: null,
    wallTime: null,
    outcome: "other",
    executionModel: "other",
    truncated: false,
  });
  NodeAssert.deepEqual(nativeTimingRow({ ...row, phase: "private-phase", body: "secret" }), row);
});
