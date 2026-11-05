import {
  KERNEL_FILE_TRANSFER_BYTES,
  type KernelFileTransferManifest,
  type KernelFileTransferPort,
} from "../../kernel/KernelFileTransfer.ts";

/** Retains one JSONL row and one frame, never the preceding rows or another file. */
export async function* readClaudeTranscriptRows(
  file: KernelFileTransferManifest[number],
  source: KernelFileTransferPort,
) {
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0)
    throw new RangeError("Invalid transcript byte count");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let row = "";
  for (let offset = 0; offset < file.bytes; offset += KERNEL_FILE_TRANSFER_BYTES) {
    const length = Math.min(KERNEL_FILE_TRANSFER_BYTES, file.bytes - offset);
    const bytes = await source.read(file.path, offset, length);
    if (bytes.length !== length) throw new Error("Claude transcript transfer ended early.");
    const text = decoder.decode(bytes, { stream: true });
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      yield row + text.slice(start, end);
      row = "";
      start = end + 1;
    }
    row += text.slice(start);
  }
  row += decoder.decode();
  if (row !== "") yield row;
}
