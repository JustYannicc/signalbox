import type { FilePersistenceResult } from "../FilePersistencePorts.ts";
import type { KernelWakeRegistry, WakeToken } from "../KernelWakeRegistry.ts";
import type { Inode } from "../storage.ts";
import type { PendingFile } from "./SqliteHydration.ts";
import { PendingContentError } from "./SqliteFileSystem.ts";
import { StorageError } from "./SqliteDatabase.ts";

type PersistenceFailure = Extract<FilePersistenceResult<never>, { status: "error" }>;
type PersistenceError = PersistenceFailure["error"];

type RegistrationError = Extract<
  ReturnType<KernelWakeRegistry["register"]>,
  { readonly status: "error" }
>["error"];

export type PendingContentRegistration<T, Failure> =
  | { readonly status: "registered"; readonly token: WakeToken; readonly attempt: T }
  | { readonly status: "failed"; readonly failure: Failure }
  | { readonly status: "missing" }
  | { readonly status: "registration_error"; readonly error: RegistrationError };

/** Shares the persistence owner's fetch while giving each leaf its own wake token. */
export function registerPendingContent<
  Failure,
  Attempt extends { readonly waiters: Set<() => void>; readonly failure: Failure | undefined },
>(input: {
  readonly inode: Inode;
  readonly pending: (inode: Inode) => PendingFile | undefined;
  readonly fetches: Map<Inode, Attempt>;
  readonly start: (file: PendingFile) => Attempt;
  readonly wakes: KernelWakeRegistry;
}): PendingContentRegistration<Attempt, Failure> {
  const existing = input.fetches.get(input.inode);
  if (existing?.failure !== undefined) {
    return { status: "failed", failure: existing.failure };
  }

  const file = input.pending(input.inode);
  if (!file) return { status: "missing" };

  let attempt = existing;
  const registration = input.wakes.register((wake) => {
    attempt ??= input.start(file);
    attempt.waiters.add(wake);
    const subscribed = attempt;
    return () => subscribed.waiters.delete(wake);
  });
  if (registration.status === "error") {
    return { status: "registration_error", error: registration.error };
  }
  if (!attempt) throw new Error("Wake registration did not subscribe");
  return { status: "registered", token: registration.value, attempt };
}

/** Retries one synchronous leaf while the persistence owner shares its fetch. */
export async function runPendingContentLeaf<
  T,
  Attempt extends {
    readonly waiters: Set<() => void>;
    readonly failure: PersistenceFailure | undefined;
  },
>(input: {
  readonly operation: () => T;
  readonly signal?: AbortSignal;
  readonly ownerSignal: AbortSignal;
  readonly ownerFailure: PersistenceFailure;
  readonly fetches: Map<Inode, Attempt>;
  readonly pending: (inode: Inode) => PendingFile | undefined;
  readonly start: (file: PendingFile) => Attempt;
  readonly wakes: KernelWakeRegistry;
  readonly hydrationError: (failure: PersistenceError) => Error;
}): Promise<T> {
  const wakeErrnos = {
    INVALID_HANDLE: "EBADF",
    RESOURCE_LIMIT: "ENOMEM",
    CANCELLED: "ECANCELED",
    EXPIRED: "ETIMEDOUT",
    ALREADY_WAITING: "EBUSY",
    IO_ERROR: "EIO",
  } as const;
  const wakeError = (code: string) =>
    new StorageError(wakeErrnos[code as keyof typeof wakeErrnos] ?? "EIO");

  for (;;) {
    if (input.signal?.aborted) throw input.signal.reason ?? new StorageError("ECANCELED");
    if (input.ownerSignal.aborted) throw input.hydrationError(input.ownerFailure.error);
    try {
      return input.operation();
    } catch (error) {
      if (!(error instanceof PendingContentError)) throw error;
      const registration = registerPendingContent<PersistenceFailure, Attempt>({
        inode: error.inode,
        pending: input.pending,
        fetches: input.fetches,
        start: input.start,
        wakes: input.wakes,
      });
      switch (registration.status) {
        case "failed":
          throw input.hydrationError(registration.failure.error);
        case "missing":
          throw input.hydrationError({
            code: "IO_ERROR",
            message: "Hydration marker disappeared",
          });
        case "registration_error":
          if (input.signal?.aborted) {
            throw input.signal.reason ?? new StorageError("ECANCELED");
          }
          throw wakeError(registration.error.code);
        case "registered":
          try {
            const result = await input.wakes.wait(registration.token, input.signal);
            if (input.signal?.aborted) throw input.signal.reason ?? new StorageError("ECANCELED");
            if (input.ownerSignal.aborted) {
              throw input.hydrationError(input.ownerFailure.error);
            }
            if (registration.attempt.failure) {
              throw input.hydrationError(registration.attempt.failure.error);
            }
            if (result.status === "error") throw wakeError(result.error.code);
          } finally {
            input.wakes.release(registration.token);
          }
          break;
      }
    }
  }
}
