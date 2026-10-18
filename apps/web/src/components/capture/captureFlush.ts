/** Joins the form's final preparation and the IndexedDB commit before acknowledging shutdown. */
export function createCaptureFlush(flushStorage: () => Promise<void>) {
  let prepare: (() => Promise<void>) | null = null;
  let pending: Promise<void> | null = null;
  return {
    register: (next: () => Promise<void>) => {
      prepare = next;
      return () => {
        if (prepare === next) prepare = null;
      };
    },
    run: () => {
      pending ??= Promise.resolve()
        .then(async () => {
          await prepare?.();
          await flushStorage();
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
