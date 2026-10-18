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
    let request: IDBRequest;
    try {
      request =
        draft === undefined
          ? store.get(KEY)
          : draft === null
            ? store.delete(KEY)
            : store.put(draft, KEY);
    } catch (cause) {
      transaction.abort();
      await done.catch(() => undefined);
      throw cause;
    }
    // Request success is not a committed transaction; quitting must wait for complete.
    await done;
    const result: DesktopPanelDraft | undefined = request.result;
    return draft === undefined ? (result ?? null) : null;
  };

  let pending: DesktopPanelDraft | null | undefined;
  let draining: Promise<void> | undefined;
  let failure: Error | null = null;
  let validationFailure: Error | null = null;
  const write = async (draft: DesktopPanelDraft | null): Promise<void> => {
    try {
      if (draft) checkBounds(draft);
      validationFailure = null;
    } catch (cause) {
      validationFailure =
        cause instanceof Error ? cause : new Error("This capture cannot be stored.");
      throw validationFailure;
    }
    pending = draft;
    // Keep only the newest edit while a transaction writes the previous snapshot.
    draining ??= (async () => {
      try {
        while (pending !== undefined) {
          const next = pending;
          pending = undefined;
          await transact(next);
        }
        failure = null;
      } catch (cause) {
        failure =
          cause instanceof Error ? cause : new Error("Couldn't keep this capture on this Mac.");
        throw failure;
      } finally {
        draining = undefined;
      }
    })();
    await draining;
  };

  return {
    read: async () => {
      await draining;
      const draft = await transact();
      if (draft) checkBounds(draft);
      return draft;
    },
    write,
    flush: async () => {
      await draining;
      if (validationFailure) throw validationFailure;
      if (failure) throw failure;
    },
  };
}

let storage: ReturnType<typeof createDesktopPanelDraftStorage> | undefined;
export function desktopPanelDraftStorage() {
  return (storage ??= createDesktopPanelDraftStorage(indexedDB));
}
