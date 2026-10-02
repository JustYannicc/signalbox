import { useCallback, useState, type ClipboardEvent, type DragEvent } from "react";

import { useCaptureDraftStore } from "./captureDraftStore";
import { describeLink, parsePastedUrl, type CaptureFile } from "./captureTokens";

let nextAttachmentId = 0;
// Time-prefixed: link ids persist across reloads, where the counter restarts.
const attachmentId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${++nextAttachmentId}`;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Files and links on the New bar. Any dropped or pasted file attaches (voice
 * notes, clips, and images are just files); pasting exactly one URL becomes a
 * link chip instead of text. Links live in the persisted New-bar draft;
 * files stay local to this open. PLACEHOLDER: nothing is uploaded.
 */
export function useCaptureAttachments() {
  const [files, setFiles] = useState<CaptureFile[]>([]);
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback((incoming: ReadonlyArray<File>) => {
    if (incoming.length === 0) return;
    setFiles((current) => [
      ...current,
      ...incoming.map((file) => ({ id: attachmentId("file"), file })),
    ]);
  }, []);

  const addLink = useCallback((url: string) => {
    useCaptureDraftStore.getState().addLink({ id: attachmentId("link"), ...describeLink(url) });
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      const pastedFiles = Array.from(event.clipboardData.files);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        addFiles(pastedFiles);
        return;
      }
      const url = parsePastedUrl(event.clipboardData.getData("text/plain"));
      if (url) {
        event.preventDefault();
        addLink(url);
      }
    },
    [addFiles, addLink],
  );

  const dropHandlers = {
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event) && !event.dataTransfer.types.includes("text/uri-list")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      setDragging(false);
      const droppedFiles = Array.from(event.dataTransfer.files);
      const url = parsePastedUrl(event.dataTransfer.getData("text/uri-list").split("\n")[0] ?? "");
      if (droppedFiles.length === 0 && !url) return;
      event.preventDefault();
      event.stopPropagation();
      addFiles(droppedFiles);
      if (droppedFiles.length === 0 && url) addLink(url);
    },
  };

  return {
    files,
    dragging,
    handlePaste,
    dropHandlers,
    removeFile: (id: string) => setFiles((current) => current.filter((file) => file.id !== id)),
  };
}
