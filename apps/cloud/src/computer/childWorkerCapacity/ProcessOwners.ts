// @effect-diagnostics cryptoRandomUUID:off - lease identities cross the portable kernel capability boundary.
import type { ChildWorkerAdmissionTopology, ChildWorkerCapacityRequester } from "./types.ts";
import { KernelProcessAdmissionOwner } from "../../kernel/KernelProcessAdmissionPort.ts";

/** Admission owns lease identities; kernel capabilities own their process attachment. */
export class ChildWorkerProcessOwners {
  readonly #remote = new Set<string>();

  classify(
    requester: ChildWorkerCapacityRequester | undefined,
  ): ChildWorkerAdmissionTopology | Promise<ChildWorkerAdmissionTopology> {
    if (requester === undefined) return { nested: false, family: undefined };
    if ("owner" in requester) {
      return requester.owner.describe().then((topology) => ({
        nested: topology.owner !== undefined && this.#remote.has(topology.owner),
        family: { processes: topology.scope, parentPid: topology.parentPid },
      }));
    }
    const owner = requester.processes.admissionOwner(requester.process);
    const info =
      requester.process === undefined ? undefined : requester.processes.info?.(requester.process);
    const parentPid =
      requester.parentPid ?? (info?.status === "ok" ? info.value.parentPid : undefined);
    return {
      nested:
        owner.status === "ok" &&
        owner.value instanceof KernelProcessAdmissionOwner &&
        this.#remote.has(owner.value.id),
      family:
        parentPid === undefined || !Number.isSafeInteger(parentPid) || parentPid < 0
          ? undefined
          : { processes: requester.processes.admissionScope ?? requester.processes, parentPid },
    };
  }

  async bind(requester: ChildWorkerCapacityRequester): Promise<() => void> {
    if ("owner" in requester) {
      const token = crypto.randomUUID();
      await requester.owner.bind(token);
      this.#remote.add(token);
      return () => this.#remote.delete(token);
    }
    if (requester.process === undefined)
      throw new Error("Child worker requester process is unavailable");
    const token = new KernelProcessAdmissionOwner(crypto.randomUUID());
    const assigned = requester.processes.setAdmissionOwner(requester.process, token);
    if (assigned.status !== "ok") throw new Error("Child worker requester process is unavailable");
    this.#remote.add(token.id);
    return () => this.#remote.delete(token.id);
  }
}
