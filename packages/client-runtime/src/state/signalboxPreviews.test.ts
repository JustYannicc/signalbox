import { ThreadId } from "@t3tools/contracts";
import { SignalboxPreviewError } from "@t3tools/contracts/signalboxPreviews";
import { describe, expect, it } from "vite-plus/test";

import { previewOpenFailureMessage, previewPortsToOffer } from "./signalboxPreviews.ts";

const threadId = ThreadId.make("thread-1");

describe("previewPortsToOffer", () => {
  it("offers the same empty list before the first snapshot and while no machine runs", () => {
    const none = previewPortsToOffer(null);
    expect(none).toEqual([]);
    expect(previewPortsToOffer({ threadId, ports: [] })).toBe(none);
  });

  it("orders ports ascending so the control doesn't reshuffle", () => {
    const ports = previewPortsToOffer({
      threadId,
      ports: [
        { port: 8080, processName: "node" },
        { port: 3000, processName: null },
        { port: 5173, processName: "vite" },
      ],
    });
    expect(ports.map((entry) => entry.port)).toEqual([3000, 5173, 8080]);
  });
});

describe("previewOpenFailureMessage", () => {
  it("passes the environment's reason through", () => {
    expect(
      previewOpenFailureMessage(new SignalboxPreviewError({ message: "Nothing listens on 5173." })),
    ).toBe("Nothing listens on 5173.");
  });

  it("falls back when the failure carries no reason", () => {
    expect(previewOpenFailureMessage(undefined)).toBe("Couldn't open the preview. Try again.");
    expect(previewOpenFailureMessage(new Error("  "))).toBe(
      "Couldn't open the preview. Try again.",
    );
  });
});
