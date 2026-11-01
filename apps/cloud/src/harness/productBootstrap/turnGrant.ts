import { readRpcData } from "../../rpc/Resources.ts";
import type { HarnessMcpTurnGrantSource } from "../HarnessSessionHost.ts";
import type { HarnessCProductTurnGrantSource } from "./contracts.ts";

export function productTurnGrantSource<G>(
  service: HarnessCProductTurnGrantSource<G>,
): HarnessMcpTurnGrantSource<G> {
  return {
    async issue({ signal, ...claims }) {
      signal.throwIfAborted();
      let removeAbortListener = () => {};
      const cancellation = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.close();
          signal.addEventListener("abort", abort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            removeAbortListener();
            abort();
          }
        },
        cancel: () => removeAbortListener(),
      });
      try {
        const result = await readRpcData(service.issue({ ...claims, cancellation }));
        signal.throwIfAborted();
        return result;
      } catch (cause) {
        signal.throwIfAborted();
        throw cause;
      } finally {
        removeAbortListener();
      }
    },
  };
}

/** The issuer receives a local signal and joins its cancellation reader before returning. */
export function createHarnessCProductTurnGrantSource<G>(
  source: HarnessMcpTurnGrantSource<G>,
): HarnessCProductTurnGrantSource<G> {
  return {
    async issue({ cancellation, ...claims }) {
      const controller = new AbortController();
      const reader = cancellation.getReader();
      let finished = false;
      const cancelled = reader.read().then(
        () => {
          if (!finished) controller.abort();
        },
        (cause) => {
          if (!finished) controller.abort(cause);
        },
      );
      try {
        return await source.issue({ ...claims, signal: controller.signal });
      } finally {
        finished = true;
        await reader.cancel().catch(() => {});
        await cancelled;
        reader.releaseLock();
      }
    },
  };
}
