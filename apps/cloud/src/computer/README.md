# Computer process slots

`ChildWorkerCapacity` admits child dispatches through [`ProcessSlots.ts`](./ProcessSlots.ts). The adapter must match the context that performs the Dynamic Worker fetch: a Durable Object I/O context can have ten distinct live Worker IDs; a plain Worker request can have four. The 2026-10-23 deployed probe confirmed immediate rejection of the 11th DO or 5th Worker ID. Cloudflare does not queue overflow. Forwarding nested work back through the same DO spends that DO's quota; forwarding it from a separate Worker request spends that request's quota. The logical child process does not own or move the quota.

A `CHILD_WORKERS` RPC starts one child in a separate plain Worker request, so a DO capacity of 10 caps ten RPCs across ten request contexts. `ChildWorkerDispatch` is the `WorkerEntrypoint` behind the RPC; its `run()` creates `createCompiledChildWorkerLoader`, which performs one `loader.get` and one `child.run` in that request. The native [warm-state fixture](./tests/WorkerLoaderWarmStateFixture.ts) shows the other boundary: one plain Worker `fetch` owns one capacity and can launch two child invocations concurrently, so that path stays at 4.

Cloudflare bills a Dynamic Worker per loader ID per day and `LOADER.load` per call. A process-slot ID is `${owner}/${codeId}/${index}.${generation}`. Keep `owner` stable for the supervisor and dispatch context. DO callers pass `thread/${ctx.id}` and `ctx.storage`, so generations survive object wakes. A short-lived Worker request can use the in-memory `CommandProcessSlotStore`. There is no random owner fallback.

An acknowledged normal stop releases the lease and lets the next process warm-reuse the same ID. Memory or isolate loss retires the generation and invalidates the old Worker. Each acquire still gets a fresh opaque lease token, so old callbacks cannot act on a reused ID.

Logical waiting does not close a Dynamic Worker fetch or free its platform slot. `ProcessSlots.park` cannot be wired around an open fetch. Physical Bash parking captures Asyncify state in bounded external storage and hands off its lease only after the dispatch RPC returns and the process stop is acknowledged. Resume reacquires capacity, possibly on a different slot, before restoring state.

Programs without checkpoint parking still hold their slots while blocked. Pipelines that need more such leaf programs running simultaneously than the context limit can deadlock until #1388 adds those checkpoints or #1396 places them elsewhere.

The 2026-10-23 deployed probe confirmed the [Dynamic Workers platform limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/) and [Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/) behavior described above.
