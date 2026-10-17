import * as Effect from "effect/Effect";

import type { KernelApi, KernelApiError, KernelBrowserRequest } from "./KernelApi.ts";

/** For tests: Kernel's browsers in memory, and what it was asked. */
export const memoryKernel = () => {
  const browsers = new Map<string, KernelBrowserRequest>();
  const profiles: Array<string> = [];
  const deletedProfiles: Array<string> = [];
  const created: Array<KernelBrowserRequest> = [];
  const deleted: Array<string> = [];
  const calls: Array<string> = [];
  let next = 0;
  let refuse: KernelApiError | null = null;
  let refuseDelete: KernelApiError | null = null;
  const api: KernelApi = {
    ensureProfile: (name) =>
      Effect.sync(() => {
        calls.push(`ensure-profile:${name}`);
        if (!profiles.includes(name)) profiles.push(name);
      }),
    deleteProfile: (name) =>
      Effect.sync(() => {
        calls.push(`delete-profile:${name}`);
        const index = profiles.indexOf(name);
        if (index >= 0) profiles.splice(index, 1);
        deletedProfiles.push(name);
      }),
    createBrowser: (request) =>
      Effect.suspend(() => {
        if (refuse !== null) return Effect.fail(refuse);
        const id = `browser-${++next}`;
        browsers.set(id, request);
        created.push(request);
        return Effect.succeed({
          session_id: id,
          cdp_ws_url: `wss://cdp.test/${id}`,
        });
      }),
    getBrowser: (id) =>
      Effect.sync(() =>
        browsers.has(id) ? { session_id: id, cdp_ws_url: `wss://cdp.test/${id}` } : null,
      ),
    deleteBrowser: (id) =>
      Effect.suspend(() => {
        calls.push(`delete-browser:${id}`);
        if (refuseDelete !== null) return Effect.fail(refuseDelete);
        browsers.delete(id);
        deleted.push(id);
        return Effect.void;
      }),
  };
  return {
    api,
    browsers,
    profiles,
    deletedProfiles,
    created,
    deleted,
    calls,
    refuseWith: (error: KernelApiError | null) => {
      refuse = error;
    },
    refuseDeleteWith: (error: KernelApiError | null) => {
      refuseDelete = error;
    },
  };
};
