import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as DesktopCaptureShutdown from "../../capture/DesktopCaptureShutdown.ts";
import * as DesktopQuickCapture from "../../capture/DesktopQuickCapture.ts";
import { submitCapture } from "./capture.ts";

describe("quick capture IPC sender boundary", () => {
  it.effect("rejects stale and subframe panel requests before writing the queue", () => {
    const acceptedIds: number[] = [];
    const capture = {
      isCapturePanelSender: (senderId: number, frameUrl: string) =>
        Effect.sync(() => senderId === 9 && frameUrl === "signalbox://app/#/capture"),
      submit: (input: unknown) =>
        Effect.sync(() => {
          acceptedIds.push(9);
          return input;
        }),
    } as unknown as DesktopQuickCapture.DesktopQuickCapture["Service"];
    const payload = {
      id: "11111111-1111-4111-8111-111111111111",
      text: "Keep this",
      files: [],
      destinationKey: null,
      source: "quick-capture" as const,
      open: false,
    };

    return Effect.gen(function* () {
      const missingFrame = yield* Effect.exit(
        submitCapture.handler(payload, { sender: { id: 9 } }),
      );
      const nullFrame = yield* Effect.exit(
        submitCapture.handler(payload, { sender: { id: 9 }, senderFrame: null }),
      );
      const staleContents = yield* Effect.exit(
        submitCapture.handler(payload, {
          sender: { id: 8 },
          senderFrame: { url: "signalbox://app/#/capture", parent: null },
        }),
      );
      const subframe = yield* Effect.exit(
        submitCapture.handler(payload, {
          sender: { id: 9 },
          senderFrame: { url: "signalbox://app/#/capture", parent: {} },
        }),
      );
      assert.isTrue(Exit.isFailure(missingFrame));
      assert.isTrue(Exit.isFailure(nullFrame));
      assert.isTrue(Exit.isFailure(staleContents));
      assert.isTrue(Exit.isFailure(subframe));
      assert.deepEqual(acceptedIds, []);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(DesktopQuickCapture.DesktopQuickCapture, capture),
          DesktopCaptureShutdown.layer,
        ),
      ),
    );
  });
});
