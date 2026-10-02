/**
 * File chips for `MockBoundComposer` surfaces that opt into attachments: pasted,
 * dropped and picked files collect as removable chips. PLACEHOLDER: nothing is
 * uploaded or sent; the surface's `onSend` still only sees the prompt.
 */
import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import type { CaptureFile } from "../capture/captureTokens";

let nextAttachmentId = 0;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function useMockComposerAttachments(enabled: boolean) {
  const [files, setFiles] = useState<ReadonlyArray<CaptureFile>>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (incoming: ReadonlyArray<File>) => {
    if (incoming.length === 0) return;
    setFiles((current) => [
      ...current,
      ...incoming.map((file) => ({ id: `mock-file-${++nextAttachmentId}`, file })),
    ]);
  };

  return {
    files,
    dragging,
    inputRef,
    removeFile: (id: string) => setFiles((current) => current.filter((file) => file.id !== id)),
    /** Empties the chips after a send. */
    clear: () => setFiles([]),
    openPicker: () => inputRef.current?.click(),
    /** For the hidden `<input type="file">` the paperclip opens. */
    onInputChange: (input: HTMLInputElement) => {
      addFiles(Array.from(input.files ?? []));
      input.value = "";
    },
    /** The editor's paste handler: files become chips, text pastes as usual. */
    onPaste: (event: ClipboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const pasted = Array.from(event.clipboardData.files);
      if (pasted.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      addFiles(pasted);
    },
    /** Capture-phase handlers for the form, so the editor never sees file drops. */
    dropHandlers: enabled
      ? {
          onDragOverCapture: (event: DragEvent<HTMLElement>) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
          },
          onDragLeaveCapture: (event: DragEvent<HTMLElement>) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          },
          onDropCapture: (event: DragEvent<HTMLElement>) => {
            setDragging(false);
            const dropped = Array.from(event.dataTransfer.files);
            if (dropped.length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            addFiles(dropped);
          },
        }
      : {},
  };
}
