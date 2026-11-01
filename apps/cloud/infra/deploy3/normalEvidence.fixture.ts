import { BlobJournal } from "./qualification/fixture/blobJournal.ts";
import { ClaudeAttemptJournal } from "./qualification/fixture/claudeAttemptJournal.ts";
import { emptyClaudeAttemptResources } from "./qualification/fixture/claudeAttemptCounters.ts";
import { rpcResourceSnapshot } from "../../src/rpc/Resources.ts";

export async function producerBackedExportFixture() {
  const values = new Map<string, unknown>();
  const list = async <A>(options: {
    readonly prefix?: string;
    readonly startAfter?: string;
    readonly limit?: number;
  }) => {
    const entries = [...values.entries()]
      .filter(
        ([key]) =>
          key.startsWith(options.prefix ?? "") &&
          (options.startAfter === undefined || key > options.startAfter),
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    return new Map(entries.map(([key, value]) => [key, value as A]));
  };
  let storage!: DurableObjectStorage;
  storage = {
    async get<A>(key: string) {
      return values.get(key) as A | undefined;
    },
    async put<A>(key: string, value: A) {
      values.set(key, value);
    },
    async transaction<A>(run: (transaction: unknown) => Promise<A>) {
      return await run(storage);
    },
    list,
  } as unknown as DurableObjectStorage;

  const journal = new BlobJournal(storage);
  await journal.append("producer-parity", { source: "BlobJournal" });

  const attempts = new ClaudeAttemptJournal(storage);
  const finished = await attempts.start("not-owned", rpcResourceSnapshot());
  await attempts.start("owned", rpcResourceSnapshot());
  await attempts.finish(finished, "success", emptyClaudeAttemptResources(), rpcResourceSnapshot());

  const failed = await attempts.start("owned", rpcResourceSnapshot());
  await attempts.finish(
    failed,
    "failure",
    emptyClaudeAttemptResources(),
    rpcResourceSnapshot(),
    "first-failure",
  );

  let blobRequests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/export/page") {
      const page = await journal.page(
        url.searchParams.get("prefix") ?? "",
        url.searchParams.get("startAfter") ?? undefined,
      );
      return Response.json(page);
    }
    if (url.pathname === "/export/blob") {
      blobRequests++;
      const ref = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly bytes: number;
        readonly sha256: string;
      };
      return new Response(await journal.read(ref));
    }
    throw new Error("Unexpected normal export request");
  };
  return { fetchImpl, storage, blobRequestCount: () => blobRequests };
}
