import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ReleaseChunkOmittedEvent,
  ReleaseChunkOmittedFailure,
  ReleaseOmissionConfiguration,
} from "@t3tools/contracts/harnessReleaseOmission";

const decode = Schema.decodeUnknownSync(ReleaseOmissionConfiguration, {
  onExcessProperty: "error",
});

describe("release omission host configuration", () => {
  it.each(["product", "qualification"])("accepts %s environment configuration", (name) => {
    expect(decode({ name, env: { HOME: "/home/claude", HTTP_PROXY: "" } })).toEqual({
      name,
      env: { HOME: "/home/claude", HTTP_PROXY: "" },
    });
  });

  it("rejects settings and non-string environment values", () => {
    expect(() => decode({ name: "product", env: {}, settings: {} })).toThrow();
    expect(() => decode({ name: "product", env: { HOME: true } })).toThrow();
  });
});

describe("release omission report contracts", () => {
  it("accepts the generated event fields and rejects legacy chunk ids", () => {
    const decode = Schema.decodeUnknownSync(ReleaseChunkOmittedEvent, {
      onExcessProperty: "error",
    });
    const event = {
      code: "RELEASE_CHUNK_OMITTED",
      inputPath: "bun-graph:/chunks/lazy.js",
      tier: "corpus",
    } as const;
    expect(decode(event)).toEqual(event);
    expect(() => decode({ ...event, chunkId: event.inputPath })).toThrow();
  });

  it("shares the event fields in the serialized failure", () => {
    const decode = Schema.decodeUnknownSync(ReleaseChunkOmittedFailure, {
      onExcessProperty: "error",
    });
    const failure = {
      _tag: "ReleaseChunkOmittedFailure",
      code: "RELEASE_CHUNK_OMITTED",
      inputPath: "bun-graph:/chunks/lazy.js",
      tier: "configuration",
      message: "Release module was omitted.",
      stack: "ReleaseChunkOmittedFailure: Release module was omitted.",
    } as const;
    expect(decode(failure)).toEqual(failure);
    expect(() => decode({ ...failure, chunkId: failure.inputPath })).toThrow();
  });
});
