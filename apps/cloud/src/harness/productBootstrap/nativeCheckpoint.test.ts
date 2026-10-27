import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HarnessCheckpoint } from "../Harness.ts";
import type { HarnessRunArtifact } from "../HarnessRunStore.ts";
import { dataForDriver } from "../adapter/tests/data.ts";
import {
  decodeHarnessCProductNativeCheckpoint,
  encodeHarnessCProductNativeCheckpoint,
} from "../HarnessCProductCheckpoint.ts";

const digest = async (bytes: Uint8Array) => {
  const result = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("product native checkpoint payload", () => {
  it.effect("checks the artifact bytes and provider session before exposing the checkpoint", () =>
    Effect.gen(function* () {
      const source = yield* dataForDriver(ProviderDriverKind.make("claude-code"));
      const nativeSessionId = "native-thread";
      const checkpoint: HarnessCheckpoint = {
        release: {
          harness: "claude-code",
          version: "fixture",
          manifestSha256: "a".repeat(64),
          modules: {},
        },
        providerSession: source.providerSession,
        snapshot: {
          providerThread: {
            ...source.providerThread,
            nativeThreadRef: {
              driver: source.driver,
              nativeId: nativeSessionId,
              strength: "strong",
            },
          },
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
        },
        revision: { commit: "checkpoint-revision" },
      };
      const bytes = new TextEncoder().encode(
        encodeHarnessCProductNativeCheckpoint({ schemaVersion: 1, nativeSessionId, checkpoint }),
      );
      const reference: HarnessRunArtifact = {
        id: "checkpoint-a",
        bytes: bytes.byteLength,
        sha256: yield* Effect.promise(() => digest(bytes)),
      };

      const decoded = yield* Effect.promise(() =>
        decodeHarnessCProductNativeCheckpoint({
          reference,
          expectedNativeSessionId: nativeSessionId,
          bytes,
        }),
      );
      expect(decoded.checkpoint.snapshot.providerThread.nativeThreadRef?.nativeId).toBe(
        nativeSessionId,
      );
      yield* Effect.promise(() =>
        expect(
          decodeHarnessCProductNativeCheckpoint({
            reference,
            expectedNativeSessionId: "another-session",
            bytes,
          }),
        ).rejects.toThrow("another native session"),
      );
      const tampered = bytes.slice();
      tampered[tampered.length - 1] = 32;
      yield* Effect.promise(() =>
        expect(
          decodeHarnessCProductNativeCheckpoint({
            reference,
            expectedNativeSessionId: nativeSessionId,
            bytes: tampered,
          }),
        ).rejects.toThrow("hash does not match"),
      );
    }).pipe(Effect.scoped),
  );
});
