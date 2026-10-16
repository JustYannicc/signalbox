import * as Effect from "effect/Effect";

import type { KernelApi, KernelApiError, KernelBrowserRequest } from "./KernelApi.ts";

/** For tests: Kernel's browsers in memory, and what it was asked. */
export const memoryKernel = () => {
  const browsers = new Map<string, KernelBrowserRequest>();
  const profiles: Array<string> = [];
  const created: Array<KernelBrowserRequest> = [];
  const deleted: Array<string> = [];
  let next = 0;
  let refuse: KernelApiError | null = null;
  const api: KernelApi = {
    ensureProfile: (name) => Effect.sync(() => void profiles.push(name)),
    createBrowser: (request) =>
      Effect.suspend(() => {
        if (refuse !== null) return Effect.fail(refuse);
        const id = `browser-${++next}`;
        browsers.set(id, request);
        created.push(request);
        return Effect.succeed({
          session_id: id,
          cdp_ws_url: `wss://cdp.test/${id}`,
          browser_live_view_url: request.headless ? null : `https://live.test/${id}`,
        });
      }),
    getBrowser: (id) =>
      Effect.sync(() =>
        browsers.has(id) ? { session_id: id, cdp_ws_url: `wss://cdp.test/${id}` } : null,
      ),
    deleteBrowser: (id) =>
      Effect.sync(() => {
        browsers.delete(id);
        deleted.push(id);
      }),
  };
  return {
    api,
    browsers,
    profiles,
    created,
    deleted,
    refuseWith: (error: KernelApiError | null) => {
      refuse = error;
    },
  };
};
