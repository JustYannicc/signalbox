import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "./replayTranscript.ts";

const headerRecord = {
  type: "transcript_start",
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.156.1",
  scenario: "simple",
};
const header = JSON.stringify(headerRecord);

describe("decodeProviderReplayNdjson", () => {
  it.effect("updates legacy Codex startup expectations across restarts", () =>
    Effect.gen(function* () {
      const initialize = {
        type: "expect_outbound",
        label: "initialize/source",
        frame: {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { version: "recorded-version" },
            capabilities: {
              experimentalApi: true,
              extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } },
            },
          },
        },
      } satisfies ProviderReplayEntry;
      const start = {
        type: "expect_outbound",
        frame: { id: 2, method: "thread/start", params: { cwd: "<workspace>" } },
      } satisfies ProviderReplayEntry;
      const records = [initialize, start, initialize, start];
      const input = [header, ...records.map((record) => JSON.stringify(record))].join("\n");
      const transcript = yield* decodeProviderReplayNdjson(input);
      const expectedInitialize = {
        ...initialize,
        frame: {
          ...initialize.frame,
          params: {
            ...initialize.frame.params,
            capabilities: {
              ...initialize.frame.params.capabilities,
              extensions: {
                ...initialize.frame.params.capabilities.extensions,
                "openai/standard-form-input": {},
              },
            },
          },
        },
      };
      const expectedStart = {
        ...start,
        frame: { ...start.frame, params: { ...start.frame.params, threadSource: "user" } },
      };
      assert.deepStrictEqual(transcript.entries, [
        expectedInitialize,
        expectedStart,
        expectedInitialize,
        expectedStart,
      ]);
    }),
  );

  it.effect("preserves explicit startup values, inbound frames and other methods", () =>
    Effect.gen(function* () {
      const records = [
        {
          type: "expect_outbound",
          frame: {
            method: "initialize",
            params: { capabilities: { extensions: { "openai/standard-form-input": null } } },
          },
        },
        {
          type: "expect_outbound",
          frame: { method: "thread/start", params: { threadSource: "exec" } },
        },
        { type: "emit_inbound", frame: { method: "thread/start", params: {} } },
        { type: "expect_outbound", frame: { method: "thread/resume", params: {} } },
        { type: "expect_outbound", frame: { method: "thread/fork", params: {} } },
        {
          type: "expect_outbound",
          frame: { method: "tool/call", params: { method: "thread/start", params: {} } },
        },
      ] satisfies ProviderReplayEntry[];
      const transcript = yield* decodeProviderReplayNdjson(
        [header, ...records.map((record) => JSON.stringify(record))].join("\n"),
      );
      assert.deepStrictEqual(transcript.entries, records);
    }),
  );

  it.effect("leaves other providers and protocols unchanged", () =>
    Effect.gen(function* () {
      const record = {
        type: "expect_outbound",
        frame: { method: "thread/start", params: {} },
      } satisfies ProviderReplayEntry;
      for (const metadata of [
        { provider: "claude", protocol: "claude.agent-sdk" },
        { provider: "codex", protocol: "other.protocol" },
      ]) {
        const transcript = yield* decodeProviderReplayNdjson(
          [JSON.stringify({ ...headerRecord, ...metadata }), JSON.stringify(record)].join("\n"),
        );
        assert.deepStrictEqual(transcript.entries, [record]);
      }
    }),
  );

  it.effect("reads the header and entries, skipping blank lines", () =>
    Effect.gen(function* () {
      const transcript = yield* decodeProviderReplayNdjson(
        [
          header,
          "",
          JSON.stringify({ type: "expect_outbound", frame: { method: "initialize" } }),
          JSON.stringify({ type: "emit_inbound", frame: { result: {} } }),
        ].join("\n"),
      );

      assert.strictEqual(transcript.provider, "codex");
      assert.strictEqual(transcript.scenario, "simple");
      assert.deepStrictEqual(
        transcript.entries.map((entry) => entry.type),
        ["expect_outbound", "emit_inbound"],
      );
    }),
  );

  it.effect("rejects a second transcript_start record", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeProviderReplayNdjson([header, header].join("\n")));

      assert.strictEqual(error._tag, "ProviderReplayNdjsonLineParseError");
      assert.strictEqual(
        error._tag === "ProviderReplayNdjsonLineParseError" && error.lineNumber,
        2,
      );
    }),
  );

  it.effect("requires a header unless fallback metadata is given", () =>
    Effect.gen(function* () {
      const entry = JSON.stringify({ type: "emit_inbound", frame: {} });

      const error = yield* Effect.flip(decodeProviderReplayNdjson(entry));
      assert.strictEqual(error._tag, "ProviderReplayNdjsonMissingHeaderError");

      const transcript = yield* decodeProviderReplayNdjson(entry, {
        provider: "pi",
        protocol: "pi.rpc-jsonl",
        version: "1",
        scenario: "fallback",
      });
      assert.strictEqual(transcript.entries.length, 1);
    }),
  );
});

describe("materializeReplayTranscriptWorkspace", () => {
  it("replaces workspace placeholders in outbound frames only", () => {
    const transcript = materializeReplayTranscriptWorkspace(
      {
        provider: "codex",
        protocol: "codex.app-server",
        version: "0.156.1",
        scenario: "simple",
        entries: [
          {
            type: "expect_outbound",
            frame: { params: { cwd: "<workspace>", argv: ["<workspace>"] } },
          },
          { type: "emit_inbound", frame: { cwd: "<workspace>" } },
        ],
      },
      "/tmp/fixture",
    );

    assert.deepStrictEqual(transcript.entries[0], {
      type: "expect_outbound",
      frame: { params: { cwd: "/tmp/fixture", argv: ["/tmp/fixture"] } },
    });
    assert.deepStrictEqual(transcript.entries[1], {
      type: "emit_inbound",
      frame: { cwd: "<workspace>" },
    });
  });
});
