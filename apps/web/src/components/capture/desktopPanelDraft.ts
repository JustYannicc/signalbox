import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import type { Capture } from "./useSaveCapture";

export interface DesktopPanelDraft {
  readonly id: string;
  readonly capture: Capture;
}

const STORE = "draft";
const KEY = "current";
const FILES_KEY = "files";
const WRITE_DELAY_MS = 200;
type DraftFiles = Capture["files"];
interface StoredDraft {
  readonly version: 2;
  readonly id: string;
  readonly capture: Omit<Capture, "files">;
  readonly fileIds: ReadonlyArray<string>;
}

function checkBounds(draft: DesktopPanelDraft) {
  if (
    draft.capture.text.length > 100_000 ||
    draft.capture.files.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
    draft.capture.files.some(({ file }) => file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
  ) {
    throw new Error("This capture is too large to keep on this Mac. Shorten it or remove a file.");
  }
}

/** One unsent panel snapshot, including File bytes and the original account destination. */
export function createDesktopPanelDraftStorage(factory: IDBFactory) {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("signalbox:desktop-capture", 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE);
      });
      request.addEventListener("success", () => {
        const db = request.result;
        const invalidate = () => {
          database = undefined;
        };
        db.addEventListener("close", invalidate);
        db.addEventListener("versionchange", () => {
          invalidate();
          db.close();
        });
        resolve(db);
      });
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("blocked", () =>
        reject(new Error("Capture storage is blocked. Restart Signalbox.")),
      );
    }).catch((cause: unknown) => {
      database = undefined;
      throw cause;
    });
    return database;
  };

  let committedFiles: DraftFiles | undefined;
  const transact = async (draft?: DesktopPanelDraft | null) => {
    const db = await open();
    const transaction = db.transaction(STORE, draft === undefined ? "readonly" : "readwrite", {
      durability: "strict",
    });
    const done = new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Capture storage was interrupted.")),
      );
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    const store = transaction.objectStore(STORE);
    let record: IDBRequest<DesktopPanelDraft | StoredDraft | undefined> | undefined;
    let files: IDBRequest<DraftFiles | undefined> | undefined;
    try {
      if (draft === undefined) {
        record = store.get(KEY);
        files = store.get(FILES_KEY);
      } else if (draft === null) {
        store.delete(KEY);
        store.delete(FILES_KEY);
      } else {
        const { files: nextFiles, ...capture } = draft.capture;
        // Text edits must not structured-clone the same potentially 50 MiB of File bytes.
        if (
          !committedFiles ||
          committedFiles.length !== nextFiles.length ||
          nextFiles.some(
            ({ id, file }, index) =>
              id !== committedFiles?.[index]?.id || file !== committedFiles?.[index]?.file,
          )
        )
          store.put(nextFiles, FILES_KEY);
        const metadata: StoredDraft = {
          version: 2,
          id: draft.id,
          capture,
          fileIds: nextFiles.map(({ id }) => id),
        };
        store.put(metadata, KEY);
      }
    } catch (cause) {
      transaction.abort();
      await done.catch(() => undefined);
      throw cause;
    }
    // Request success is not a committed transaction; quitting must wait for complete.
    await done;
    if (draft !== undefined) {
      committedFiles = draft?.capture.files;
      return null;
    }
    const result = record?.result;
    if (!result) return null;
    // Legacy snapshots stay untouched until a new draft is successfully committed.
    if (!("version" in result)) {
      committedFiles = undefined;
      checkBounds(result);
      return result;
    }
    const restoredFiles = files?.result;
    if (
      !restoredFiles ||
      result.fileIds.length !== restoredFiles.length ||
      result.fileIds.some((id, index) => id !== restoredFiles[index]?.id)
    ) {
      throw new Error("Capture attachments couldn't be restored. Your saved draft is unchanged.");
    }
    const restored = { id: result.id, capture: { ...result.capture, files: restoredFiles } };
    checkBounds(restored);
    committedFiles = restoredFiles;
    return restored;
  };

  let pending: DesktopPanelDraft | null | undefined;
  let draining: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters: Array<{ resolve: () => void; reject: (cause: Error) => void }> = [];
  let failure: Error | null = null;
  let validationFailure: Error | null = null;
  const drain = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    draining ??= Promise.resolve().then(async () => {
      try {
        while (pending !== undefined) {
          const next = pending;
          const batch = waiters;
          pending = undefined;
          waiters = [];
          try {
            await transact(next);
            failure = null;
            for (const waiter of batch) waiter.resolve();
          } catch (cause) {
            const error =
              cause instanceof Error ? cause : new Error("Couldn't keep this capture on this Mac.");
            // Only unsaved content blocks quit. A queued capture can safely replay its same ID.
            failure = next === null ? null : error;
            for (const waiter of batch) waiter.reject(error);
          }
        }
      } finally {
        draining = undefined;
      }
    });
    return draining;
  };
  const write = async (
    draft: DesktopPanelDraft | null,
    options?: { readonly immediate: boolean },
  ): Promise<void> => {
    try {
      if (draft) checkBounds(draft);
      validationFailure = null;
    } catch (cause) {
      validationFailure =
        cause instanceof Error ? cause : new Error("This capture cannot be stored.");
      throw validationFailure;
    }
    pending = draft;
    const committed = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    clearTimeout(timer);
    if (draft === null || options?.immediate) void drain();
    else timer = setTimeout(() => void drain(), WRITE_DELAY_MS);
    await committed;
  };

  return {
    read: async () => {
      if (pending !== undefined || draining) await drain();
      return transact();
    },
    write,
    flush: async () => {
      if (pending !== undefined || draining) await drain();
      if (validationFailure) throw validationFailure;
      if (failure) throw failure;
    },
  };
}

let storage: ReturnType<typeof createDesktopPanelDraftStorage> | undefined;
export function desktopPanelDraftStorage() {
  return (storage ??= createDesktopPanelDraftStorage(indexedDB));
}
