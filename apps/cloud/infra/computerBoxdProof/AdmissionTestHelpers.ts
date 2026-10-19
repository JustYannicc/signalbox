import { ComputerBoxdProof } from "./worker.ts";

export const proofOwner = "sb-computer-boxd-12345678";
export const proofToken = "proof-test-token";

export interface StoragePort {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  sync(): Promise<void>;
}

export class FakeStorage implements StoragePort {
  readonly values = new Map<string, unknown>();
  readonly writes: { key: string; value: unknown }[] = [];

  async get(key: string) {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(input: string | Record<string, unknown>, value?: unknown) {
    const entries = typeof input === "string" ? [[input, value] as const] : Object.entries(input);
    for (const [key, item] of entries) {
      const copy = structuredClone(item);
      this.writes.push({ key, value: copy });
      this.values.set(key, copy);
    }
  }

  async setAlarm(_time: number) {}

  async deleteAlarm() {}

  async sync() {}
}

export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

export function createWorker(storage: FakeStorage, abort?: (reason?: string) => void) {
  const background: Promise<unknown>[] = [];
  const initialization = { ready: Promise.resolve() };
  const ctx = {
    storage,
    blockConcurrencyWhile(callback: () => Promise<void>) {
      initialization.ready = callback();
      return initialization.ready;
    },
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
    abort,
  };
  const env = {
    BOXD_PROOF_OWNER: proofOwner,
    BOXD_PROOF_TOKEN: proofToken,
    BOXD_API_KEY: "test-only-key",
    CHILD_WORKERS: {},
  };
  const worker = new ComputerBoxdProof(ctx as never, env as never);
  return { worker, ready: initialization.ready, background };
}

export function request(worker: ComputerBoxdProof, path: string, body?: string) {
  const headers = new Headers({ authorization: `Bearer ${proofToken}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return worker.fetch(
    new Request(`https://proof.test${path}`, {
      method: path === "/status" ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
}

export async function status(worker: ComputerBoxdProof) {
  const response = await request(worker, "/status");
  return (await response.json()) as {
    status: string;
    cleanupConfirmed: boolean;
    checks: Record<string, string>;
    vmNames: string[];
  };
}

export async function confirmCleanup(storage: StoragePort) {
  const current = (await storage.get("proof-state")) as
    | { checks: Record<string, string>; [key: string]: unknown }
    | undefined;
  if (!current) throw new Error("Proof state was missing during cleanup");
  await storage.put("proof-state", {
    ...current,
    cleanupConfirmed: true,
    checks: { ...current.checks, providerCleanup: "passed" },
  });
  return true;
}
