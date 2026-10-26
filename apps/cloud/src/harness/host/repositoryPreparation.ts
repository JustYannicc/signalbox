/** Startup cancellation joins Git's index write before the computer can be torn down. */
export function repositoryPreparationLifetime(source: AbortSignal) {
  const owner = new AbortController();
  let preparing = true;
  const abort = () => {
    if (!preparing && source.aborted) owner.abort(source.reason);
  };
  source.addEventListener("abort", abort, { once: true });
  return {
    signal: owner.signal,
    settle() {
      preparing = false;
      abort();
    },
    dispose() {
      source.removeEventListener("abort", abort);
      owner.abort(new Error("Product file owner closed"));
    },
  };
}
