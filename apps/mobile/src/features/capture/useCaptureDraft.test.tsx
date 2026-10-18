// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { CaptureTarget } from "./destinations";

type DraftRecord = {
  text: string;
  attachments: ReadonlyArray<DraftComposerAttachment>;
  project?: {
    environmentId: string;
    projectId: string;
    folderStart?: unknown;
  };
};

const drafts = vi.hoisted(() => {
  const records = new Map<string, DraftRecord>();
  let sequence = 0;
  return {
    create(project: { environmentId: string; projectId: string }) {
      const key = `capture-draft-${++sequence}`;
      records.set(key, { text: "", attachments: [], project: { ...project } });
      return key;
    },
    clear(key: string) {
      records.delete(key);
    },
    read(key: string) {
      return records.get(key);
    },
    reset() {
      records.clear();
      sequence = 0;
    },
    setFolderStart(key: string, start: CaptureTarget["start"]) {
      const draft = records.get(key);
      if (!draft?.project) return;
      if (
        draft.project.environmentId === start.environmentId &&
        draft.project.projectId === start.projectId
      ) {
        draft.project.folderStart = { ...start };
      }
    },
    retarget(key: string, project: { environmentId: string; projectId: string }) {
      const draft = records.get(key);
      if (!draft?.project) return;
      if (
        draft.project.environmentId === project.environmentId &&
        draft.project.projectId === project.projectId
      ) {
        return;
      }
      draft.project = { ...project, folderStart: null };
    },
    setText(key: string, text: string) {
      const draft = records.get(key);
      if (draft) draft.text = text;
    },
    append(key: string, attachments: ReadonlyArray<DraftComposerAttachment>) {
      const draft = records.get(key);
      if (draft) draft.attachments = [...draft.attachments, ...attachments];
      return 0;
    },
    removeAttachment(key: string, attachmentId: string) {
      const draft = records.get(key);
      if (draft) {
        draft.attachments = draft.attachments.filter(
          (attachment) => attachment.id !== attachmentId,
        );
      }
    },
  };
});

vi.mock("../../state/use-composer-drafts", () => ({
  appendComposerDraftAttachments: drafts.append,
  captureComposerDraftInsertion: (key: string, selection?: { start: number; end: number }) => {
    const draft = drafts.read(key);
    return { text: draft?.text ?? "", ...(selection ?? { start: 0, end: 0 }) };
  },
  clearComposerDraft: drafts.clear,
  createNewTaskDraft: drafts.create,
  getComposerDraftSnapshot: (key: string) => drafts.read(key) ?? { text: "", attachments: [] },
  removeComposerDraftAttachment: drafts.removeAttachment,
  retargetNewTaskDraft: drafts.retarget,
  setNewTaskDraftFolderStart: drafts.setFolderStart,
  setComposerDraftText: drafts.setText,
  useComposerDraft: (key: string | null) =>
    (key ? drafts.read(key) : undefined) ?? { text: "", attachments: [] },
}));

import { useCaptureDraft } from "./useCaptureDraft";

function target(
  folderId: string,
  environmentId = "environment-a",
  projectId = "project-a",
): CaptureTarget {
  return {
    start: {
      environmentId,
      projectId,
      folderId,
      name: folderId,
      file: true,
      unfiledName: "Personal top level",
    },
  } as unknown as CaptureTarget;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const attachment: DraftComposerAttachment = {
  id: "picked-image",
  type: "image",
  name: "picked.png",
  mimeType: "image/png",
  sizeBytes: 3,
  previewUri: "file:///picked.png",
  dataUrl: "data:image/png;base64,YWJj",
};

describe("capture draft destination", () => {
  let root: Root | null;
  let current: ReturnType<typeof useCaptureDraft>;

  function Probe(props: { readonly target: CaptureTarget | null }) {
    const capture = useCaptureDraft(props.target);
    useLayoutEffect(() => {
      current = capture;
    }, [capture]);
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    drafts.reset();
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    drafts.reset();
  });

  it("stores a late picker result in the destination currently shown by the route", async () => {
    act(() => root!.render(<Probe target={target("folder-a")} />));
    let draftKey = "";
    act(() => {
      draftKey = current.prepare() ?? "";
    });
    const addFromPickerStartedAtA = current.addAttachments;
    const pickerResult = deferred<ReadonlyArray<DraftComposerAttachment>>();
    const finishingPicker = pickerResult.promise.then((attachments) =>
      addFromPickerStartedAtA(attachments, { text: "", start: 0, end: 0 }),
    );

    act(() => root!.render(<Probe target={target("folder-b", "environment-b", "project-b")} />));
    await act(async () => {
      pickerResult.resolve([attachment]);
      await finishingPicker;
    });

    const persisted = drafts.read(draftKey);
    expect(persisted?.project).toMatchObject({
      environmentId: "environment-b",
      projectId: "project-b",
      folderStart: { folderId: "folder-b" },
    });
    expect(persisted?.attachments).toEqual([attachment]);
  });

  it("removes a prepared empty draft when the capture closes", () => {
    act(() => root!.render(<Probe target={target("folder-a")} />));
    let draftKey = "";
    act(() => {
      draftKey = current.prepare() ?? "";
    });
    expect(drafts.read(draftKey)).toBeDefined();

    act(() => root?.unmount());
    root = null;
    expect(drafts.read(draftKey)).toBeUndefined();
  });

  it("waits for a pending import before finalizing the same text draft", async () => {
    act(() => root!.render(<Probe target={target("folder-a")} />));
    const text = "Keep this draft";
    let draftKey = "";
    act(() => {
      draftKey = current.prepare() ?? "";
      current.setText(text);
    });

    const conversion = deferred<ReadonlyArray<DraftComposerAttachment>>();
    let finalized = false;
    let finalDraftKey: string | null = null;
    let finishing = Promise.resolve();
    act(() => {
      current.trackImport(async () => {
        const attachments = await conversion.promise;
        current.addAttachments(attachments, { text, start: text.length, end: text.length });
      });
      finishing = (async () => {
        await current.awaitImports();
        finalized = true;
        finalDraftKey = current.prepare();
      })();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(current.isImporting).toBe(true);
    expect(finalized).toBe(false);

    conversion.resolve([attachment]);
    await act(async () => finishing);

    expect(finalized).toBe(true);
    expect(finalDraftKey).toBe(draftKey);
    expect(drafts.read(draftKey)).toMatchObject({ text, attachments: [attachment] });
    expect(current.isImporting).toBe(false);
  });

  it("keeps an existing draft when an import finishes after its destination disappears", async () => {
    act(() => root!.render(<Probe target={target("folder-a")} />));
    const text = "Keep this draft";
    let draftKey = "";
    act(() => {
      draftKey = current.prepare() ?? "";
      current.setText(text);
    });

    const conversion = deferred<void>();
    let importing = Promise.resolve();
    act(() => {
      importing = current.trackImport(async () => {
        await conversion.promise;
        current.addAttachments([attachment], { text, start: text.length, end: text.length });
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.isImporting).toBe(true);

    act(() => root!.render(<Probe target={null} />));

    conversion.resolve();
    await act(async () => {
      await importing.catch(() => undefined);
      await current.awaitImports();
    });

    expect(current.isImporting).toBe(false);
    expect(drafts.read(draftKey)).toMatchObject({
      text,
      attachments: [],
      project: { environmentId: "environment-a" },
    });
    expect(drafts.read("capture-draft-2")).toBeUndefined();
  });
});
