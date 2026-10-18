import {
  persistComposerAttachmentFile,
  removePersistedComposerAttachmentFile,
  type DraftComposerFileAttachment,
} from "./composerImages";
import { uuidv4 } from "./uuid";

export async function copyVoiceNoteAttachment(
  uri: string,
  maxBytes: number,
): Promise<DraftComposerFileAttachment> {
  const { File } = await import("expo-file-system");
  const extension = uri.split(/[?#]/)[0]?.split(".").at(-1)?.toLowerCase();
  const format =
    extension === "wav"
      ? { extension, type: "audio/wav" }
      : extension === "webm"
        ? { extension, type: "audio/webm" }
        : { extension: "m4a", type: "audio/mp4" };
  const name = `Voice note ${new Date().toISOString().replaceAll(":", "-")}.${format.extension}`;
  const fileUri = await persistComposerAttachmentFile(uri, name, maxBytes);
  try {
    const sizeBytes = new File(fileUri).size;
    if (!sizeBytes) throw new Error("No audio was recorded. Try recording again.");
    if (sizeBytes > maxBytes) throw new Error("This voice note is too large to attach.");
    return { id: uuidv4(), type: "file", name, mimeType: format.type, sizeBytes, fileUri };
  } catch (error) {
    await removePersistedComposerAttachmentFile(fileUri);
    throw error;
  }
}
