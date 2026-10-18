import { describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_DRAFT_STORAGE_KEY, useComposerDraftStore } from "../../composerDraftStore";
import {
  captureAttachmentId,
  completeCaptureDraftReceipt,
  readCaptureDraftReceipt,
  reserveCaptureDraftReceipt,
  runCaptureOnce,
  verifyPersistedCaptureDraft,
  type CaptureReceiptStorage,
} from "./durableCapture";
import { saveCaptureDraftDurably } from "./durableCaptureDraft";

class MemoryStorage implements CaptureReceiptStorage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("durable capture receipts", () => {
  it("reuses the pre-seed reservation after a crash", () => {
    const storage = new MemoryStorage();

    expect(reserveCaptureDraftReceipt("capture-1", "draft-1", false, storage)).toMatchObject({
      draftId: "draft-1",
      phase: "reserved",
      filed: false,
    });
    expect(reserveCaptureDraftReceipt("capture-1", "draft-retry", true, storage)).toMatchObject({
      draftId: "draft-1",
      phase: "reserved",
      filed: false,
    });
    expect(readCaptureDraftReceipt("capture-1", storage)?.draftId).toBe("draft-1");
    expect(readCaptureDraftReceipt("capture-1", storage)?.phase).toBe("reserved");
  });

  it("stores a completed phase for acknowledgement retries", () => {
    const storage = new MemoryStorage();
    reserveCaptureDraftReceipt("capture-1", "draft-1", false, storage);

    expect(completeCaptureDraftReceipt("capture-1", "draft-1", storage)).toMatchObject({
      draftId: "draft-1",
      phase: "completed",
      filed: false,
    });
    expect(reserveCaptureDraftReceipt("capture-1", "draft-retry", true, storage).phase).toBe(
      "completed",
    );
  });

  it.each(["edited", "deleted"] as const)(
    "replays a completed receipt without inspecting a %s draft",
    async (draftState) => {
      const storage = new MemoryStorage();
      reserveCaptureDraftReceipt("capture-complete", "draft-1", true, storage);
      completeCaptureDraftReceipt("capture-complete", "draft-1", storage);
      storage.reads.length = 0;
      if (draftState === "edited") {
        storage.setItem(
          COMPOSER_DRAFT_STORAGE_KEY,
          JSON.stringify({
            state: { draftsByThreadKey: { "draft-1": { prompt: "User edit" } } },
          }),
        );
      }
      const getState = vi.spyOn(useComposerDraftStore, "getState");
      try {
        const result = await saveCaptureDraftDurably({
          captureId: "capture-complete",
          text: "Original capture",
          prepared: { images: [], files: [], skipped: [] },
          receiptStorage: storage,
          createDraft: async () => {
            throw new Error("completed captures must not create another draft");
          },
          startUploadsAndPersistFiles: async () => {
            throw new Error("completed captures must not touch attachments");
          },
        });

        expect(result).toMatchObject({ ok: true, draftId: "draft-1" });
        expect(getState).not.toHaveBeenCalled();
        expect(storage.reads).not.toContain(COMPOSER_DRAFT_STORAGE_KEY);
      } finally {
        getState.mockRestore();
      }
    },
  );

  it("fails when storage does not read back the reserved draft", () => {
    const storage: CaptureReceiptStorage = {
      getItem: () => null,
      setItem: () => {},
    };

    expect(() => reserveCaptureDraftReceipt("capture-1", "draft-1", true, storage)).toThrow(
      "The capture receipt could not be persisted",
    );
  });

  it("coalesces concurrent delivery attempts for one capture id", async () => {
    let complete!: (result: boolean) => void;
    let calls = 0;
    const run = () => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        complete = resolve;
      });
    };

    const first = runCaptureOnce("capture-1", run);
    const second = runCaptureOnce("capture-1", run);
    await Promise.resolve();
    complete(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(calls).toBe(1);
  });

  it("uses stable attachment ids from the queued capture and source file", () => {
    expect(captureAttachmentId("capture-1", "file-1", "file", 0)).toBe(
      captureAttachmentId("capture-1", "file-1", "file", 0),
    );
    expect(captureAttachmentId("capture-1", "file-1", "file", 0)).not.toBe(
      captureAttachmentId("capture-1", "file-1", "image", 0),
    );
    expect(captureAttachmentId("capture-1", "file-1", "file", 0)).not.toBe(
      captureAttachmentId("capture-1", "file-1", "file", 1),
    );
  });
});

describe("persisted capture draft proof", () => {
  it("requires the prompt, image bytes, and uploaded file reference to read back", () => {
    const storage = new MemoryStorage();
    const expectedImage = {
      id: "image-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 4,
      dataUrl: "data:image/png;base64,AAAA",
    };
    const expectedFile = {
      id: "file-1",
      attachmentId: "upload-1",
      environmentId: "environment-1",
    };
    storage.setItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: 9,
        state: {
          draftThreadsByThreadKey: { "draft-1": { threadId: "thread-1" } },
          draftsByThreadKey: {
            "draft-1": {
              prompt: "Look at this",
              attachments: [expectedImage],
              files: [expectedFile],
            },
          },
        },
      }),
    );

    const expected = {
      draftId: "draft-1",
      prompt: "Look at this",
      images: [expectedImage],
      files: [expectedFile],
      storage,
    };
    expect(verifyPersistedCaptureDraft(expected)).toBe(true);
    expect(
      verifyPersistedCaptureDraft({
        ...expected,
        files: [{ ...expectedFile, attachmentId: "" }],
      }),
    ).toBe(false);
    expect(
      verifyPersistedCaptureDraft({
        ...expected,
        images: [{ ...expectedImage, dataUrl: "data:image/png;base64,BBBB" }],
      }),
    ).toBe(false);
  });
});
