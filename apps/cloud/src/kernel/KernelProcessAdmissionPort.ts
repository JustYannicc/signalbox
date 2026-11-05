import type { KernelHandle } from "./KernelAbi.ts";
import type { KernelProcessTable } from "./KernelProcessTable.ts";

export interface KernelProcessAdmissionPort {
  describe(): Promise<{
    readonly scope: string;
    readonly parentPid: number;
    readonly owner?: string;
  }>;
  bind(owner: string): Promise<void>;
}

export class KernelProcessAdmissionOwner {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
    Object.freeze(this);
  }
}

/** Captures one live kernel handle; remote admission never receives the process table. */
export function createKernelProcessAdmissionPort(input: {
  readonly processes: KernelProcessTable;
  readonly process: KernelHandle<"process"> | undefined;
  readonly parentPid?: number;
  readonly signal: AbortSignal;
}): KernelProcessAdmissionPort & { close(): void } {
  let state: typeof input | undefined = { ...input };
  const current = () => {
    if (state === undefined)
      throw Object.assign(new Error("Process admission capability is closed"), { code: "EBADF" });
    state.signal.throwIfAborted();
    return state;
  };
  return {
    async describe() {
      const { processes, process, parentPid } = current();
      const info = processes.info(process);
      const owner = processes.admissionOwner(process);
      if (info.status !== "ok" || owner.status !== "ok")
        throw Object.assign(new Error("Process is unavailable"), { code: "ESRCH" });
      return {
        scope: processes.admissionScope,
        parentPid: parentPid ?? info.value.parentPid,
        ...(owner.value instanceof KernelProcessAdmissionOwner ? { owner: owner.value.id } : {}),
      };
    },
    async bind(owner) {
      const { processes, process } = current();
      if (typeof owner !== "string" || owner.length === 0)
        throw new TypeError("Process admission owner must be nonempty");
      if (
        process === undefined ||
        processes.setAdmissionOwner(process, new KernelProcessAdmissionOwner(owner)).status !== "ok"
      )
        throw Object.assign(new Error("Process is unavailable"), { code: "ESRCH" });
    },
    close() {
      state = undefined;
    },
  };
}
