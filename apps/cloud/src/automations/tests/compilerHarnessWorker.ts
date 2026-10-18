import { makeDistributedCompiler } from "../distributedCompiler.ts";

const selected = new Set<string>();
const coldLoads = new Map<string, number>();
const modules = new Map<string, string[]>();

export default {
  async fetch(request: Request, env: { readonly LOADER: WorkerLoader }) {
    const compiler = makeDistributedCompiler({
      get: (id, code) => {
        if (id === null) throw new Error("Compiler workers must have immutable IDs.");
        selected.add(id);
        return env.LOADER.get(id, async () => {
          coldLoads.set(id, (coldLoads.get(id) ?? 0) + 1);
          const result = await code();
          modules.set(id, Object.keys(result.modules));
          return result;
        });
      },
      load: () => {
        throw new Error("Compiler must reuse LOADER.get.");
      },
    });
    if (new URL(request.url).pathname === "/memory") {
      return Response.json({
        linearMemoryBytes: await compiler.memoryBytes(),
        workers: [...selected],
        coldLoads: Object.fromEntries(coldLoads),
        modules: Object.fromEntries(modules),
      });
    }
    return Response.json(await compiler.compile(await request.text()));
  },
};
