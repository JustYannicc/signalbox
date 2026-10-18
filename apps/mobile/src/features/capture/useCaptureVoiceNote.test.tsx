// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  DraftComposerAttachment,
  DraftComposerFileAttachment,
} from "../../lib/composerImages";
import type { useVoiceInputController } from "../voice-input/useVoiceInputController";

type Draft = { text: string; attachments: ReadonlyArray<DraftComposerAttachment> };
type VoiceControllerInput = Parameters<typeof useVoiceInputController>[0];

const mocks = vi.hoisted(() => {
  const drafts = new Map<string, Draft>();
  return {
    drafts,
    events: [] as string[],
    input: null as VoiceControllerInput | null,
    phase: "idle" as string,
    globalOwnerKey: "capture-owner" as string | null,
    pendingOwnerKey: null as string | null,
    stop: vi.fn<() => Promise<void>>(),
    cancelOwner: vi.fn(),
    flush: vi.fn<() => Promise<void>>(),
    removeFile: vi.fn(async (uri: string) => {
      mocks.events.push(`delete-file:${uri}`);
    }),
  };
});

vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { subscribe: () => () => undefined },
}));

vi.mock("../../state/use-composer-drafts", () => ({
  appendComposerDraftAttachments: (
    key: string,
    attachments: ReadonlyArray<DraftComposerAttachment>,
    options?: { appendReference?: boolean },
  ) => {
    const draft = mocks.drafts.get(key);
    if (!draft) return attachments.length;
    draft.attachments = [...draft.attachments, ...attachments];
    if (options?.appendReference) {
      for (const attachment of attachments) {
        draft.text += ` [[attachment:${attachment.id}]]`;
      }
    }
    mocks.events.push("append");
    return 0;
  },
  composerDraftsAtom: {},
  flushComposerDrafts: mocks.flush,
  getComposerDraftSnapshot: (key: string) => mocks.drafts.get(key) ?? { text: "", attachments: [] },
  readComposerDraftSelection: () => null,
  removeComposerDraftAttachment: (key: string, attachmentId: string) => {
    const draft = mocks.drafts.get(key);
    if (!draft) return;
    draft.attachments = draft.attachments.filter((attachment) => attachment.id !== attachmentId);
    draft.text = draft.text.replace(` [[attachment:${attachmentId}]]`, "");
    mocks.events.push(`remove:${attachmentId}`);
  },
  setComposerDraftText: (key: string, text: string) => {
    const draft = mocks.drafts.get(key);
    if (draft) draft.text = text;
  },
}));

vi.mock("../../lib/voiceNoteAttachment", () => ({
  copyVoiceNoteAttachment: async (): Promise<DraftComposerFileAttachment> => ({
    id: "voice-copy",
    type: "file",
    name: "Voice note.m4a",
    mimeType: "audio/mp4",
    sizeBytes: 12,
    fileUri: "file:///documents/voice-copy.m4a",
  }),
}));

vi.mock("../../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: mocks.removeFile,
}));

vi.mock("../../lib/composerAttachmentPreviewRetention", () => ({
  retainComposerAttachmentFileForPreview: () => () => {
    mocks.events.push("release-file");
  },
}));

vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: (input: VoiceControllerInput) => {
    mocks.input = input;
    const ownsSession = mocks.globalOwnerKey === input.ownerKey;
    return {
      state: {
        phase: ownsSession ? mocks.phase : "idle",
        error: null,
        errorAction: null,
      },
      isAvailable: true,
      isBusy:
        ownsSession &&
        (mocks.phase === "preparing" ||
          mocks.phase === "recording" ||
          mocks.phase === "transcribing"),
      hasPendingRecording: () => mocks.pendingOwnerKey === input.ownerKey,
      cancelPendingRecording: () => {
        if (mocks.pendingOwnerKey !== input.ownerKey) return;
        mocks.events.push("cancel-pending");
        mocks.pendingOwnerKey = null;
        mocks.phase = "idle";
      },
      cancelOwned: () => mocks.cancelOwner(),
      start: vi.fn(async () => undefined),
      stop: mocks.stop,
      cancel: vi.fn(),
      elapsedSeconds: 0,
      audioLevels: [],
      freezesEditor: false,
      blocksSubmission: false,
    };
  },
}));

import { useCaptureVoiceNote } from "./useCaptureVoiceNote";

const OWNER_KEY = "capture-owner";
const DRAFT_KEY = "capture-draft";
const voiceAttachment: DraftComposerFileAttachment = {
  id: "voice-copy",
  type: "file",
  name: "Voice note.m4a",
  mimeType: "audio/mp4",
  sizeBytes: 12,
  fileUri: "file:///documents/voice-copy.m4a",
};

function otherAttachment(): DraftComposerFileAttachment {
  return {
    id: "other-file",
    type: "file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    fileUri: "file:///documents/notes.txt",
  };
}

describe("capture voice note recovery", () => {
  let root: Root | null;
  let current: ReturnType<typeof useCaptureVoiceNote> | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.drafts.clear();
    mocks.events.length = 0;
    mocks.input = null;
    mocks.phase = "idle";
    mocks.globalOwnerKey = OWNER_KEY;
    mocks.pendingOwnerKey = null;
    mocks.stop.mockReset().mockResolvedValue(undefined);
    mocks.cancelOwner.mockReset();
    mocks.flush.mockReset().mockImplementation(async () => {
      mocks.events.push("flush");
    });
    mocks.removeFile.mockClear();
    mocks.drafts.set(DRAFT_KEY, {
      text: "Keep this text [[attachment:existing]]",
      attachments: [],
    });
    current = null;
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
  });

  function renderHook() {
    function Harness() {
      const result = useCaptureVoiceNote({
        ownerKey: OWNER_KEY,
        prepare: () => DRAFT_KEY,
        selection: { start: 0, end: 0 },
        onSelectionChange: () => undefined,
        disabled: false,
        maxBytes: 1_000,
      });
      useLayoutEffect(() => {
        current = result;
      }, [result]);
      return null;
    }
    act(() => root!.render(<Harness />));
    return {
      get current() {
        if (!current) throw new Error("hook has not rendered");
        return current;
      },
      rerender() {
        root!.render(<Harness />);
      },
    };
  }

  function recordingInput(): NonNullable<VoiceControllerInput["onRecording"]> {
    const onRecording = mocks.input?.onRecording;
    if (!onRecording) throw new Error("recording sink has not been registered");
    return onRecording;
  }

  function recordingContext() {
    const draft = mocks.drafts.get(DRAFT_KEY)!;
    const readDraft = () => ({
      ownerKey: OWNER_KEY,
      text: draft.text,
      selection: { start: 0, end: 0 },
      revision: 0,
    });
    return { expectedDraft: readDraft(), readDraft };
  }

  it("blocks save when stop leaves this owner's native recording pending", async () => {
    mocks.phase = "recording";
    mocks.stop.mockImplementation(async () => {
      mocks.phase = "error";
      mocks.pendingOwnerKey = OWNER_KEY;
    });
    const hook = renderHook();

    await expect(hook.current.beforeSave()).rejects.toThrow("voice note isn't saved yet");
  });

  it("does not stop another owner's recording when saving this capture", async () => {
    mocks.globalOwnerKey = "another-owner";
    mocks.phase = "recording";
    const hook = renderHook();

    await act(async () => hook.current.beforeSave());

    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("cancels its empty preparing startup instead of stopping it", async () => {
    mocks.phase = "preparing";
    const hook = renderHook();

    await act(async () => hook.current.beforeSave());

    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.cancelOwner).toHaveBeenCalledTimes(1);
  });

  it("discards only its staged audio and reference after a failed append flush", async () => {
    const other = otherAttachment();
    const originalText = "Keep this text [[attachment:existing]]";
    mocks.drafts.set(DRAFT_KEY, { text: originalText, attachments: [other] });
    mocks.phase = "error";
    mocks.pendingOwnerKey = OWNER_KEY;
    mocks.flush.mockImplementationOnce(async () => {
      mocks.events.push("flush-failed");
      throw new Error("disk unavailable");
    });
    const hook = renderHook();

    await act(async () => {
      await expect(
        recordingInput()("file:///recordings/source.m4a", recordingContext()),
      ).rejects.toThrow("disk unavailable");
    });
    await act(async () => hook.current.discardPendingAudio());

    const draft = mocks.drafts.get(DRAFT_KEY)!;
    expect(draft.text).toBe(originalText);
    expect(draft.attachments).toEqual([other]);
    expect(mocks.removeFile).toHaveBeenCalledWith(voiceAttachment.fileUri);
    expect(mocks.events.indexOf("remove:voice-copy")).toBeLessThan(mocks.events.indexOf("flush"));
    expect(mocks.events.indexOf("flush")).toBeLessThan(mocks.events.indexOf("release-file"));
    expect(mocks.events.indexOf("release-file")).toBeLessThan(
      mocks.events.indexOf("delete-file:file:///documents/voice-copy.m4a"),
    );
    expect(mocks.events.indexOf("delete-file:file:///documents/voice-copy.m4a")).toBeLessThan(
      mocks.events.indexOf("cancel-pending"),
    );
  });

  it("rolls back a failed staging flush after the global control cancels while hidden", async () => {
    mocks.phase = "error";
    mocks.pendingOwnerKey = OWNER_KEY;
    mocks.flush.mockImplementationOnce(async () => {
      mocks.events.push("flush-failed");
      throw new Error("sink flush failed");
    });
    const hook = renderHook();

    await act(async () => {
      await expect(
        recordingInput()("file:///recordings/source.m4a", recordingContext()),
      ).rejects.toThrow("sink flush failed");
    });
    mocks.pendingOwnerKey = null;
    mocks.phase = "idle";
    act(() => hook.rerender());
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    await act(async () => hook.current.discardPendingAudio());

    expect(mocks.drafts.get(DRAFT_KEY)?.attachments).toEqual([]);
    expect(mocks.drafts.get(DRAFT_KEY)?.text).toBe("Keep this text [[attachment:existing]]");
    expect(mocks.removeFile).toHaveBeenCalledWith(voiceAttachment.fileUri);
  });

  it("keeps a successfully persisted voice attachment on the idle transition", async () => {
    mocks.phase = "transcribing";
    const hook = renderHook();

    await act(async () => {
      await recordingInput()("file:///recordings/source.m4a", recordingContext());
    });
    mocks.phase = "idle";
    act(() => hook.rerender());

    expect(mocks.drafts.get(DRAFT_KEY)?.attachments).toEqual([voiceAttachment]);
    expect(mocks.removeFile).not.toHaveBeenCalled();
  });

  it("keeps the unsaved copy retryable when rollback flush fails", async () => {
    mocks.phase = "error";
    mocks.pendingOwnerKey = OWNER_KEY;
    mocks.flush
      .mockImplementationOnce(async () => {
        mocks.events.push("flush-sink-failed");
        throw new Error("sink flush failed");
      })
      .mockRejectedValueOnce(new Error("rollback flush failed"))
      .mockImplementationOnce(async () => {
        mocks.events.push("flush");
      });
    const hook = renderHook();

    await act(async () => {
      await expect(
        recordingInput()("file:///recordings/source.m4a", recordingContext()),
      ).rejects.toThrow("sink flush failed");
    });
    await act(async () => {
      await expect(hook.current.discardPendingAudio()).rejects.toThrow("rollback flush failed");
    });
    expect(hook.current.hasPendingAudio).toBe(true);
    expect(mocks.removeFile).not.toHaveBeenCalled();
    expect(mocks.events).not.toContain("release-file");
    expect(mocks.events).not.toContain("cancel-pending");

    await act(async () => hook.current.discardPendingAudio());
    expect(mocks.removeFile).toHaveBeenCalledTimes(1);
    expect(mocks.events).toContain("cancel-pending");
  });

  it("does not cancel a pending recording owned by another capture", async () => {
    mocks.phase = "error";
    mocks.pendingOwnerKey = "another-owner";
    const hook = renderHook();
    await act(async () => hook.current.discardPendingAudio());
    expect(mocks.pendingOwnerKey).toBe("another-owner");
    expect(mocks.events).not.toContain("cancel-pending");
  });
});
