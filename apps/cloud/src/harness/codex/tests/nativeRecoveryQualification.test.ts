import { describe, expect, it } from "vite-plus/test";
import { prepareCodexNativeAdmission } from "@signalbox/provider-codex/runtime";
import {
  inspectStoppedCodexRecovery,
  requireStartedCodexThread,
} from "./nativeRecoveryQualification.ts";

const nativeSessionId = "01a16561-4940-78e0-b2ee-e3613354307e";
const rolloutPath =
  "/home/codex/sessions/2026/10/22/rollout-2026-10-22T20-50-37-01a16561-4940-78e0-b2ee-e3613354307e.jsonl";
const startedFrame = {
  method: "thread/started",
  params: { thread: { id: nativeSessionId, path: rolloutPath } },
};

describe("Codex native recovery qualification", () => {
  it("takes the native identity and rollout path from thread/started", () => {
    expect(requireStartedCodexThread([startedFrame])).toEqual({
      nativeSessionId,
      path: rolloutPath,
    });
  });

  it("does not infer the native id from the timestamp-prefixed rollout filename", () => {
    const started = requireStartedCodexThread([startedFrame]);
    expect(started.nativeSessionId).toBe("01a16561-4940-78e0-b2ee-e3613354307e");
    expect(started.nativeSessionId).not.toBe(
      "2026-10-22T20-50-37-01a16561-4940-78e0-b2ee-e3613354307e",
    );
  });

  it("inspects stopped bytes through the production recovery inspector", () => {
    const admission = prepareCodexNativeAdmission({
      logicalRunId: "run-1070",
      nativeIncarnationId: "native-1",
      nativeSessionId,
      nativeFiles: { filesystemId: "files-1070", home: "/home/codex" },
      providerRelease: "codex-0.162.1",
      inputId: "input-1070",
    });
    const contents =
      [
        { type: "session_meta", payload: { id: nativeSessionId } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1070" } },
        { type: "event_msg", payload: { type: "user_message", client_id: "input-1070" } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n";
    const bytes = new TextEncoder().encode(contents);
    const result = inspectStoppedCodexRecovery({
      frames: [startedFrame],
      admission,
      nextNativeIncarnationId: "native-2",
      stopped: {
        nativeIncarnationId: "native-1",
        reference: { id: "stop-1070", bytes: 4, sha256: "0".repeat(64) },
      },
      file: {
        reference: {
          id: "rollout-1070",
          bytes: bytes.byteLength,
          sha256: "1".repeat(64),
        },
        contents,
      },
      pendingActions: [],
    });
    expect(result).toMatchObject({
      status: "ready",
      admission: {
        nativeSessionId,
        nativeIncarnationId: "native-2",
        nativeTurnId: "turn-1070",
        inputDurability: "native-file",
      },
      evidence: { file: { path: rolloutPath } },
    });
  });

  it("rejects a rollout path that does not identify the reported native thread", () => {
    expect(() =>
      requireStartedCodexThread([
        {
          method: "thread/started",
          params: {
            thread: { id: nativeSessionId, path: "/home/codex/sessions/rollout-other.jsonl" },
          },
        },
      ]),
    ).toThrow("canonical session rollout");
  });
});
