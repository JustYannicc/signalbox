interface HttpAgentRuntime {
  configure(resolveClient: () => unknown): void;
  drain(): Promise<void>;
}
const runtimes = new WeakMap<object, HttpAgentRuntime>();

export function registerHttpAgentRuntime(request: object, runtime: HttpAgentRuntime): void {
  runtimes.set(request, runtime);
}

function selectedRuntimes(modules: readonly object[]) {
  const selected = new Set<HttpAgentRuntime>();
  for (const module of modules) {
    const request: unknown = Reflect.get(module, "request");
    const runtime = typeof request === "function" ? runtimes.get(request) : undefined;
    if (runtime) selected.add(runtime);
  }
  return selected;
}

export function configureNodeHttpAgents(
  modules: readonly object[],
  resolveClient: () => unknown,
): void {
  for (const runtime of selectedRuntimes(modules)) runtime.configure(resolveClient);
}

export async function drainNodeHttpAgents(modules: readonly object[]): Promise<void> {
  await Promise.all([...selectedRuntimes(modules)].map((runtime) => runtime.drain()));
}
