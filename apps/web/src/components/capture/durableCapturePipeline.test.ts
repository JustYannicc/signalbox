import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  completeCaptureDraftReceipt,
  readCaptureDraftReceipt,
  readPersistedCaptureDraft,
  reserveCaptureDraftReceipt,
} from "./durableCapture";
import { saveCaptureDraftDurably } from "./durableCaptureDraft";
import type { PreparedCaptureAttachments } from "./captureAttachments";

const environmentId = EnvironmentId.make("capture-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("capture-project"));
const storage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const value = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, item: string) => {
      entries.set(key, item);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
  vi.stubGlobal("localStorage", value);
  return value;
});

function resetDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

function registerDraft(id: string): DraftId {
  const draftId = DraftId.make(id);
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
    threadId: ThreadId.make(`thread-${id}`),
  });
  return draftId;
}

async function persistDraft(draftId: DraftId): Promise<void> {
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  if (draft) {
    await useComposerDraftStore
      .getState()
      .syncPersistedAttachments(draftId, draft.persistedAttachments);
  }
}

function emptyPrepared(): PreparedCaptureAttachments {
  return { images: [], files: [], skipped: [] };
}

function saveInput(input: {
  readonly captureId: string;
  readonly text: string;
  readonly prepared?: PreparedCaptureAttachments;
  readonly createDraft: Parameters<typeof saveCaptureDraftDurably>[0]["createDraft"];
  readonly upload?: Parameters<typeof saveCaptureDraftDurably>[0]["startUploadsAndPersistFiles"];
}) {
  return saveCaptureDraftDurably({
    captureId: input.captureId,
    text: input.text,
    prepared: input.prepared ?? emptyPrepared(),
    receiptStorage: storage,
    createDraft: input.createDraft,
    startUploadsAndPersistFiles: input.upload ?? (async () => true),
  });
}

describe("durable capture pipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    resetDraftStore();
    vi.runOnlyPendingTimers();
    storage.clear();
  });

  afterEach(() => {
    resetDraftStore();
    vi.runOnlyPendingTimers();
    storage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("seeds before folder filing, then uploads and confirms serialized readback", async () => {
    const imageFile = new File(["image bytes"], "photo.png", { type: "image/png" });
    const image: ComposerImageAttachment = {
      type: "image",
      id: "capture:image:photo",
      name: imageFile.name,
      mimeType: imageFile.type,
      sizeBytes: imageFile.size,
      previewUrl: "blob:capture-photo",
      file: imageFile,
    };
    const documentFile = new File(["document bytes"], "notes.pdf", { type: "application/pdf" });
    const file: ComposerFileAttachment = {
      type: "file",
      id: "capture:file:notes",
      name: documentFile.name,
      mimeType: documentFile.type,
      sizeBytes: documentFile.size,
      file: documentFile,
    };
    const prepared: PreparedCaptureAttachments = {
      images: [{ image, dataUrl: "data:image/png;base64,UE5H" }],
      files: [file],
      skipped: [],
    };
    let finishFiling!: () => void;
    let reportSeeded!: () => void;
    const filing = new Promise<void>((resolve) => {
      finishFiling = resolve;
    });
    const seeded = new Promise<void>((resolve) => {
      reportSeeded = resolve;
    });
    const draftId = DraftId.make("capture-draft");

    const resultPromise = saveInput({
      captureId: "capture-pipeline",
      text: "Keep these together",
      prepared,
      createDraft: async (seedDraft) => {
        const createdDraftId = registerDraft(draftId);
        seedDraft(createdDraftId);
        reportSeeded();
        await filing;
        return { draftId: createdDraftId, filed: true };
      },
      upload: async (targetDraftId, targetEnvironmentId) => {
        useComposerDraftStore
          .getState()
          .setFileUpload(targetDraftId, file.id, targetEnvironmentId, "uploaded-notes");
        return true;
      },
    });

    await seeded;
    expect(readCaptureDraftReceipt("capture-pipeline", storage)).toMatchObject({
      draftId,
      phase: "reserved",
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toContain(
      "Keep these together",
    );
    finishFiling();

    await expect(resultPromise).resolves.toMatchObject({ ok: true, draftId, filed: true });
    expect(readCaptureDraftReceipt("capture-pipeline", storage)).toMatchObject({
      draftId,
      phase: "completed",
    });
    expect(readPersistedCaptureDraft(draftId, storage)).toMatchObject({
      hasSession: true,
      prompt: expect.stringContaining("Keep these together"),
      images: [
        {
          id: image.id,
          dataUrl: "data:image/png;base64,UE5H",
        },
      ],
      files: [{ id: file.id, attachmentId: "uploaded-notes", environmentId }],
    });
  });

  it("fills an existing reserved draft without creating another one", async () => {
    const draftId = registerDraft("reserved-present");
    useComposerDraftStore.getState().setPrompt(draftId, "A durable capture");
    await persistDraft(draftId);
    reserveCaptureDraftReceipt("capture-present", draftId, true, storage);
    const createDraft = vi.fn(async () => null);

    await expect(
      saveInput({ captureId: "capture-present", text: "A durable capture", createDraft }),
    ).resolves.toMatchObject({ ok: true, draftId });
    expect(createDraft).not.toHaveBeenCalled();
    expect(readCaptureDraftReceipt("capture-present", storage)?.phase).toBe("completed");
  });

  it("relocates a receipt after New removes its empty draft", async () => {
    const evictedId = registerDraft("reserved-evicted");
    reserveCaptureDraftReceipt("capture-evicted", evictedId, true, storage);

    const occupantId = registerDraft("new-thread-occupant");
    useComposerDraftStore.getState().setPrompt(occupantId, "Unrelated user work");
    await persistDraft(occupantId);
    expect(useComposerDraftStore.getState().getDraftSession(evictedId)).toBeNull();
    expect(readPersistedCaptureDraft(evictedId, storage)).toMatchObject({
      hasSession: false,
      hasDraft: false,
    });

    const relocatedId = DraftId.make("capture-relocated");
    const createDraft = vi.fn(async (seedDraft: (id: DraftId) => void) => {
      const created = registerDraft(relocatedId);
      seedDraft(created);
      return { draftId: created, filed: true };
    });

    await expect(
      saveInput({ captureId: "capture-evicted", text: "Recover this capture", createDraft }),
    ).resolves.toMatchObject({ ok: true, draftId: relocatedId });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(readCaptureDraftReceipt("capture-evicted", storage)).toMatchObject({
      draftId: relocatedId,
      phase: "completed",
    });
    expect(useComposerDraftStore.getState().getComposerDraft(occupantId)?.prompt).toBe(
      "Unrelated user work",
    );
  });

  it("leaves a diverged reserved draft untouched", async () => {
    const draftId = registerDraft("reserved-diverged");
    reserveCaptureDraftReceipt("capture-diverged", draftId, true, storage);
    useComposerDraftStore.getState().setPrompt(draftId, "The user's newer text");
    await persistDraft(draftId);
    const createDraft = vi.fn(async () => null);

    await expect(
      saveInput({ captureId: "capture-diverged", text: "The queued capture", createDraft }),
    ).rejects.toThrow("The capture draft has changed since it was queued");
    expect(createDraft).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "The user's newer text",
    );
    expect(readCaptureDraftReceipt("capture-diverged", storage)).toMatchObject({
      draftId,
      phase: "reserved",
    });
  });

  it("preflights image identity and releases only the unowned preview", async () => {
    const draftId = registerDraft("reserved-image-conflict");
    reserveCaptureDraftReceipt("capture-image-conflict", draftId, true, storage);
    const userFile = new File(["user image"], "user.png", { type: "image/png" });
    const userImage: ComposerImageAttachment = {
      type: "image",
      id: "capture:image:stable",
      name: userFile.name,
      mimeType: userFile.type,
      sizeBytes: userFile.size,
      previewUrl: "blob:user-owned",
      file: userFile,
    };
    useComposerDraftStore.getState().addImages(draftId, [userImage]);
    await persistDraft(draftId);

    const preparedFile = new File(["queued image"], "queued.png", { type: "image/png" });
    const prepared: PreparedCaptureAttachments = {
      images: [
        {
          image: {
            ...userImage,
            name: preparedFile.name,
            sizeBytes: preparedFile.size,
            previewUrl: "blob:prepared-capture",
            file: preparedFile,
          },
          dataUrl: "data:image/png;base64,UVVFVUVE",
        },
      ],
      files: [],
      skipped: [],
    };
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const createDraft = vi.fn(async () => null);

    await expect(
      saveInput({
        captureId: "capture-image-conflict",
        text: "Don't write this over the user's image",
        prepared,
        createDraft,
      }),
    ).rejects.toThrow("The capture image id already belongs to another image");
    expect(createDraft).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.images[0]).toMatchObject({
      previewUrl: "blob:user-owned",
      name: "user.png",
    });
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:prepared-capture");
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:user-owned");
  });

  it("never relocates or recreates a completed receipt", async () => {
    reserveCaptureDraftReceipt("capture-completed", "gone-draft", true, storage);
    completeCaptureDraftReceipt("capture-completed", "gone-draft", storage);
    const createDraft = vi.fn(async () => null);

    await expect(
      saveInput({ captureId: "capture-completed", text: "Already saved", createDraft }),
    ).resolves.toMatchObject({ ok: true, draftId: "gone-draft" });
    expect(createDraft).not.toHaveBeenCalled();
    expect(readCaptureDraftReceipt("capture-completed", storage)).toMatchObject({
      draftId: "gone-draft",
      phase: "completed",
    });
  });
});
