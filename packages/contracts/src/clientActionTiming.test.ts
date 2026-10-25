import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CLIENT_ACTION_IDS,
  ClientActionTiming,
  ClientActionTimingsBatch,
} from "@t3tools/contracts/clientActionTiming";
import { ProductAnalyticsClientEvent } from "@t3tools/contracts/signalboxAnalytics";

const sample = {
  action: "thread.send",
  entryPoint: "click",
  client: "web",
  os: "linux",
  device: "computer",
  release: "1.2.3",
  connection: "online",
  mode: "cloud",
  path: "optimistic",
  inputTimeMs: 12.5,
  handlerDelayMs: 1.5,
  feedback: { elapsedMs: 22, method: "browser_frame_estimate" },
  desiredState: { elapsedMs: 35, method: "commit_only" },
  eventTimingMs: 18,
  eventTimingMethod: "browser_event_timing",
  eventTimingStatus: "observed",
  acknowledgementMs: 120,
  convergenceMs: null,
  completionMs: null,
  outcome: "success",
  correlationId: "1234567890abcdef1234567890abcdef",
} as const;

const decodeTiming = Schema.decodeUnknownOption(ClientActionTiming);
const decodeBatch = Schema.decodeUnknownOption(ClientActionTimingsBatch);
const decodeEvent = Schema.decodeUnknownOption(ProductAnalyticsClientEvent);

describe("client action timing contract", () => {
  it("keeps a closed action registry and reconstructs only declared fields", () => {
    expect(CLIENT_ACTION_IDS).toContain("thread.send");
    expect(CLIENT_ACTION_IDS).toContain("model.favorite");
    expect(CLIENT_ACTION_IDS).toContain("settings.update");
    const privateText = "private-prompt-and-setting-value";
    const decoded = decodeTiming({
      ...sample,
      title: privateText,
      settingValue: privateText,
      content: { prompt: privateText },
      feedback: { ...sample.feedback, settingValue: privateText },
      desiredState: { ...sample.desiredState, value: privateText },
    });
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isSome(decoded)) {
      expect(decoded.value).toEqual(sample);
      expect(JSON.stringify(decoded.value)).not.toContain(privateText);
    }
  });

  it("bounds fields and accepts only registered action and timing methods", () => {
    expect(Option.isNone(decodeTiming({ ...sample, action: "thread.private" }))).toBe(true);
    expect(Option.isNone(decodeTiming({ ...sample, inputTimeMs: -1 }))).toBe(true);
    expect(Option.isNone(decodeTiming({ ...sample, handlerDelayMs: Infinity }))).toBe(true);
    expect(
      Option.isNone(
        decodeTiming({ ...sample, feedback: { elapsedMs: 86_400_001, method: "commit_only" } }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        decodeTiming({ ...sample, desiredState: { elapsedMs: 1, method: "some_frame" } }),
      ),
    ).toBe(true);
    expect(Option.isNone(decodeTiming({ ...sample, correlationId: "0".repeat(32) }))).toBe(true);
  });

  it("requires a batch of one to sixteen samples", () => {
    expect(Option.isSome(decodeBatch([sample]))).toBe(true);
    expect(Option.isNone(decodeBatch([]))).toBe(true);
    expect(Option.isNone(decodeBatch(Array.from({ length: 17 }, () => sample)))).toBe(true);
    expect(Option.isSome(decodeEvent({ event: "interaction.timings", samples: [sample] }))).toBe(
      true,
    );
  });
});
