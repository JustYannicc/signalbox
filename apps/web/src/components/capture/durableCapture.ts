import { COMPOSER_DRAFT_STORAGE_KEY } from "../../composerDraftStore";

const CAPTURE_RECEIPT_PREFIX = "t3code:quick-capture-draft:v1:";

export interface CaptureReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CaptureDraftReceipt {
  readonly draftId: string;
  readonly phase: "reserved" | "completed";
  readonly filed: boolean;
}

export interface PersistedCaptureImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

export interface PersistedCaptureFile {
  readonly id: string;
  readonly attachmentId: string;
  readonly environmentId: string;
}

interface PersistedDraftSnapshot {
  readonly hasSession: boolean;
  readonly hasDraft: boolean;
  readonly prompt: string;
  readonly images: ReadonlyArray<PersistedCaptureImage>;
  readonly files: ReadonlyArray<PersistedCaptureFile>;
}

const inFlightCaptures = new Map<string, Promise<unknown>>();

function browserStorage(): CaptureReceiptStorage {
  try {
    if (typeof globalThis.localStorage !== "undefined") return globalThis.localStorage;
  } catch {
    // Accessing localStorage itself can fail when browser storage is disabled.
  }
  throw new Error("Browser storage is unavailable");
}

function captureReceiptKey(captureId: string): string {
  return `${CAPTURE_RECEIPT_PREFIX}${encodeURIComponent(captureId)}`;
}

function parseCaptureReceipt(raw: string, captureId: string): CaptureDraftReceipt {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.captureId !== captureId ||
    typeof value.draftId !== "string" ||
    value.draftId.length === 0 ||
    (value.phase !== undefined && value.phase !== "reserved" && value.phase !== "completed")
  ) {
    throw new Error("The saved capture receipt is invalid");
  }
  return {
    draftId: value.draftId,
    phase: value.phase === "completed" ? "completed" : "reserved",
    filed: value.filed !== false,
  };
}

export function readCaptureDraftReceipt(
  captureId: string,
  storage: CaptureReceiptStorage = browserStorage(),
): CaptureDraftReceipt | null {
  if (captureId.trim().length === 0) throw new Error("A capture id is required");
  const raw = storage.getItem(captureReceiptKey(captureId));
  return raw === null ? null : parseCaptureReceipt(raw, captureId);
}

/** Reserves the draft identity before any capture content is written to it. */
export function reserveCaptureDraftReceipt(
  captureId: string,
  draftId: string,
  filed = true,
  storage: CaptureReceiptStorage = browserStorage(),
): CaptureDraftReceipt {
  if (captureId.trim().length === 0 || draftId.trim().length === 0) {
    throw new Error("A capture id and draft id are required");
  }
  const existing = readCaptureDraftReceipt(captureId, storage);
  if (existing !== null) return existing;

  storage.setItem(
    captureReceiptKey(captureId),
    JSON.stringify({ version: 1, captureId, draftId, phase: "reserved", filed }),
  );
  const persisted = readCaptureDraftReceipt(captureId, storage);
  if (persisted?.draftId !== draftId || persisted.phase !== "reserved") {
    throw new Error("The capture receipt could not be persisted");
  }
  return persisted;
}

/** Updates only a reserved receipt, with the old draft id acting as a compare-and-set guard. */
export function updateReservedCaptureDraftReceipt(
  captureId: string,
  expectedDraftId: string,
  draftId: string,
  filed: boolean,
  storage: CaptureReceiptStorage = browserStorage(),
): CaptureDraftReceipt {
  if (
    captureId.trim().length === 0 ||
    expectedDraftId.trim().length === 0 ||
    draftId.trim().length === 0
  ) {
    throw new Error("A capture id and draft ids are required");
  }
  const existing = readCaptureDraftReceipt(captureId, storage);
  if (existing?.phase === "completed") return existing;
  if (existing?.phase !== "reserved" || existing.draftId !== expectedDraftId) {
    throw new Error("The reserved capture draft changed before it could be updated");
  }

  storage.setItem(
    captureReceiptKey(captureId),
    JSON.stringify({ version: 1, captureId, draftId, phase: "reserved", filed }),
  );
  const persisted = readCaptureDraftReceipt(captureId, storage);
  if (
    persisted?.draftId !== draftId ||
    persisted.phase !== "reserved" ||
    persisted.filed !== filed
  ) {
    throw new Error("The reserved capture receipt could not be updated");
  }
  return persisted;
}

export function completeCaptureDraftReceipt(
  captureId: string,
  draftId: string,
  storage: CaptureReceiptStorage = browserStorage(),
): CaptureDraftReceipt {
  const existing = readCaptureDraftReceipt(captureId, storage);
  if (existing === null || existing.draftId !== draftId) {
    throw new Error("The capture draft receipt was not reserved");
  }
  if (existing.phase === "completed") return existing;
  storage.setItem(
    captureReceiptKey(captureId),
    JSON.stringify({
      version: 1,
      captureId,
      draftId,
      phase: "completed",
      filed: existing.filed,
    }),
  );
  const persisted = readCaptureDraftReceipt(captureId, storage);
  if (persisted?.draftId !== draftId || persisted.phase !== "completed") {
    throw new Error("The completed capture receipt could not be persisted");
  }
  return persisted;
}

export function captureAttachmentId(
  captureId: string,
  fileId: string,
  kind: "file" | "image",
  index: number,
): string {
  return `capture:${encodeURIComponent(captureId)}:${kind}:${index}:${encodeURIComponent(fileId)}`;
}

/** Coalesces duplicate delivery attempts in one browser runtime. */
export function runCaptureOnce<T>(captureId: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightCaptures.get(captureId);
  if (existing) return existing as Promise<T>;

  const result = Promise.resolve().then(run);
  inFlightCaptures.set(captureId, result);
  void result.then(
    () => {
      if (inFlightCaptures.get(captureId) === result) inFlightCaptures.delete(captureId);
    },
    () => {
      if (inFlightCaptures.get(captureId) === result) inFlightCaptures.delete(captureId);
    },
  );
  return result;
}

/** Reads the serialized composer state after its deferred writer has been flushed. */
export function readPersistedCaptureDraft(
  draftId: string,
  storage: CaptureReceiptStorage = browserStorage(),
): PersistedDraftSnapshot | null {
  const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !isRecord(value.state)) return null;
  const state = value.state;
  const draft = isRecord(state.draftsByThreadKey) ? state.draftsByThreadKey[draftId] : undefined;
  const session = isRecord(state.draftThreadsByThreadKey)
    ? state.draftThreadsByThreadKey[draftId]
    : undefined;
  const attachments = isRecord(draft) && Array.isArray(draft.attachments) ? draft.attachments : [];
  const files = isRecord(draft) && Array.isArray(draft.files) ? draft.files : [];

  return {
    hasSession: isRecord(session),
    hasDraft: isRecord(draft),
    prompt: isRecord(draft) && typeof draft.prompt === "string" ? draft.prompt : "",
    images: attachments.flatMap((attachment): PersistedCaptureImage[] =>
      isRecord(attachment) &&
      typeof attachment.id === "string" &&
      typeof attachment.name === "string" &&
      typeof attachment.mimeType === "string" &&
      typeof attachment.sizeBytes === "number" &&
      typeof attachment.dataUrl === "string"
        ? [
            {
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              dataUrl: attachment.dataUrl,
            },
          ]
        : [],
    ),
    files: files.flatMap((file): PersistedCaptureFile[] =>
      isRecord(file) &&
      typeof file.id === "string" &&
      typeof file.attachmentId === "string" &&
      file.attachmentId.length > 0 &&
      typeof file.environmentId === "string"
        ? [{ id: file.id, attachmentId: file.attachmentId, environmentId: file.environmentId }]
        : [],
    ),
  };
}

/** Malformed or partial storage is not proof that a reserved draft was evicted. */
export function isPersistedCaptureDraftAbsent(
  draftId: string,
  storage: CaptureReceiptStorage = browserStorage(),
): boolean {
  const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  if (raw === null) return true;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(value) || !isRecord(value.state)) return false;
  const drafts = value.state.draftsByThreadKey;
  const sessions = value.state.draftThreadsByThreadKey;
  if (!isRecord(drafts) || !isRecord(sessions)) return false;
  return (
    !Object.prototype.hasOwnProperty.call(drafts, draftId) &&
    !Object.prototype.hasOwnProperty.call(sessions, draftId)
  );
}

export function verifyPersistedCaptureDraft(input: {
  readonly draftId: string;
  readonly prompt: string;
  readonly images: ReadonlyArray<PersistedCaptureImage>;
  readonly files: ReadonlyArray<PersistedCaptureFile>;
  readonly storage?: CaptureReceiptStorage;
}): boolean {
  const snapshot = readPersistedCaptureDraft(input.draftId, input.storage);
  if (!snapshot?.hasSession || snapshot.prompt !== input.prompt) return false;

  const imagesById = new Map(snapshot.images.map((image) => [image.id, image]));
  if (
    input.images.some((expected) => {
      const persisted = imagesById.get(expected.id);
      return (
        persisted?.name !== expected.name ||
        persisted.mimeType !== expected.mimeType ||
        persisted.sizeBytes !== expected.sizeBytes ||
        persisted.dataUrl !== expected.dataUrl
      );
    })
  ) {
    return false;
  }

  const filesById = new Map(snapshot.files.map((file) => [file.id, file]));
  return input.files.every((expected) => {
    const persisted = filesById.get(expected.id);
    return (
      persisted !== undefined &&
      persisted.environmentId === expected.environmentId &&
      persisted.attachmentId === expected.attachmentId
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
