import { describe, expect, it } from "@effect/vitest";

import {
  classifyThinkingOnlyCompanion,
  createReplayInputIntervals,
  THINKING_ONLY_RETRY_PROFILE,
} from "./replayGeneratedInputs.ts";

const publicThinkingOnlyContent =
  "[Your previous response had no visible output. Please continue and produce a user-visible response.]";

const recordedCompanion = {
  type: "user",
  isMeta: true,
  turnCompanion: true,
  message: { role: "user", content: publicThinkingOnlyContent },
};

describe("generated replay inputs", () => {
  it("classifies only the exact released thinking-only companion record", async () => {
    await expect(
      classifyThinkingOnlyCompanion(recordedCompanion, { releaseVersion: "2.1.303" }),
    ).resolves.toEqual({
      profile: THINKING_ONLY_RETRY_PROFILE.profile,
      contentSha256: THINKING_ONLY_RETRY_PROFILE.contentSha256,
    });
    await expect(
      classifyThinkingOnlyCompanion(recordedCompanion, { releaseVersion: "2.1.302" }),
    ).resolves.toBeNull();
    await expect(
      classifyThinkingOnlyCompanion(
        {
          ...recordedCompanion,
          isMeta: false,
        },
        { releaseVersion: "2.1.303" },
      ),
    ).resolves.toBeNull();
    await expect(
      classifyThinkingOnlyCompanion(
        {
          ...recordedCompanion,
          message: { ...recordedCompanion.message, content: `${publicThinkingOnlyContent} ` },
        },
        { releaseVersion: "2.1.303" },
      ),
    ).resolves.toBeNull();
  });

  it("rejects missing companion metadata, non-user records, and non-string content", async () => {
    const message = { role: "user", content: publicThinkingOnlyContent };
    await expect(
      classifyThinkingOnlyCompanion(
        {
          type: "user",
          isMeta: true,
          message,
        },
        { releaseVersion: "2.1.303" },
      ),
    ).resolves.toBeNull();
    await expect(
      classifyThinkingOnlyCompanion(
        {
          type: "user",
          turnCompanion: true,
          message,
        },
        { releaseVersion: "2.1.303" },
      ),
    ).resolves.toBeNull();
    await expect(
      classifyThinkingOnlyCompanion(
        {
          ...recordedCompanion,
          type: "assistant",
        },
        { releaseVersion: "2.1.303" },
      ),
    ).resolves.toBeNull();
    await expect(
      classifyThinkingOnlyCompanion(
        {
          ...recordedCompanion,
          message: { ...message, role: "assistant" },
        },
        { releaseVersion: "2.1.303" },
      ),
    ).resolves.toBeNull();
    await expect(
      classifyThinkingOnlyCompanion(
        {
          ...recordedCompanion,
          message: { ...message, content: [publicThinkingOnlyContent] },
        },
        { releaseVersion: "2.1.303" },
      ),
    ).resolves.toBeNull();
  });

  it("leaves native input boundaries unchanged when there are no companions", () => {
    const boundaries = [
      { responseMessageCount: 2, outcome: "nonterminal" },
      { responseMessageCount: 0, outcome: "response-less" },
      { responseMessageCount: 1, outcome: "terminal" },
    ] as const;

    expect(createReplayInputIntervals(boundaries)).toEqual([
      {
        startIndex: 0,
        endIndex: 0,
        responseMessageCount: 2,
        outcome: "nonterminal",
        generated: [],
      },
      {
        startIndex: 1,
        endIndex: 1,
        responseMessageCount: 0,
        outcome: "response-less",
        generated: [],
      },
      {
        startIndex: 2,
        endIndex: 2,
        responseMessageCount: 1,
        outcome: "terminal",
        generated: [],
      },
    ]);
  });

  it("groups the generated companion with its preceding native input", () => {
    const intervals = createReplayInputIntervals(
      [
        { responseMessageCount: 3, outcome: "nonterminal" },
        { responseMessageCount: 4, outcome: "terminal" },
        { responseMessageCount: 2, outcome: "terminal" },
      ],
      [
        {
          index: 1,
          profile: THINKING_ONLY_RETRY_PROFILE.profile,
          contentSha256: THINKING_ONLY_RETRY_PROFILE.contentSha256,
          isMeta: true,
          turnCompanion: true,
        },
      ],
    );

    expect(intervals).toEqual([
      {
        startIndex: 0,
        endIndex: 1,
        responseMessageCount: 7,
        outcome: "terminal",
        generated: [
          {
            index: 1,
            profile: THINKING_ONLY_RETRY_PROFILE.profile,
            contentSha256: THINKING_ONLY_RETRY_PROFILE.contentSha256,
            isMeta: true,
            turnCompanion: true,
          },
        ],
      },
      {
        startIndex: 2,
        endIndex: 2,
        responseMessageCount: 2,
        outcome: "terminal",
        generated: [],
      },
    ]);
  });

  it("rejects an unpaired or malformed companion", () => {
    expect(() =>
      createReplayInputIntervals(
        [{ responseMessageCount: 1, outcome: "terminal" }],
        [
          {
            index: 0,
            profile: THINKING_ONLY_RETRY_PROFILE.profile,
            contentSha256: THINKING_ONLY_RETRY_PROFILE.contentSha256,
            isMeta: true,
            turnCompanion: true,
          },
        ],
      ),
    ).toThrow("ERR_REPLAY_INPUT_INTERVALS_COMPANIONS");

    expect(() =>
      createReplayInputIntervals(
        [
          { responseMessageCount: 1, outcome: "terminal" },
          { responseMessageCount: 1, outcome: "terminal" },
        ],
        [
          {
            index: 1,
            profile: THINKING_ONLY_RETRY_PROFILE.profile,
            contentSha256: "different-content",
            isMeta: true,
            turnCompanion: true,
          },
        ],
      ),
    ).toThrow("ERR_REPLAY_INPUT_INTERVALS_COMPANIONS");
  });

  it("rejects duplicate and out-of-order companion indices", () => {
    const boundaries = [
      { responseMessageCount: 1, outcome: "terminal" },
      { responseMessageCount: 1, outcome: "terminal" },
      { responseMessageCount: 1, outcome: "terminal" },
    ] as const;
    const companion = (index: number) => ({
      index,
      profile: THINKING_ONLY_RETRY_PROFILE.profile,
      contentSha256: THINKING_ONLY_RETRY_PROFILE.contentSha256,
      isMeta: true as const,
      turnCompanion: true as const,
    });

    expect(() => createReplayInputIntervals(boundaries, [companion(1), companion(1)])).toThrow(
      "ERR_REPLAY_INPUT_INTERVALS_COMPANIONS",
    );
    expect(() => createReplayInputIntervals(boundaries, [companion(2), companion(1)])).toThrow(
      "ERR_REPLAY_INPUT_INTERVALS_COMPANIONS",
    );
  });

  it("rejects response counts that overflow when intervals are joined", () => {
    expect(() =>
      createReplayInputIntervals(
        [
          { responseMessageCount: Number.MAX_SAFE_INTEGER, outcome: "nonterminal" },
          { responseMessageCount: 1, outcome: "terminal" },
        ],
        [
          {
            index: 1,
            profile: THINKING_ONLY_RETRY_PROFILE.profile,
            contentSha256: THINKING_ONLY_RETRY_PROFILE.contentSha256,
            isMeta: true,
            turnCompanion: true,
          },
        ],
      ),
    ).toThrow("ERR_REPLAY_INPUT_INTERVALS_COMPANIONS");
  });
});
