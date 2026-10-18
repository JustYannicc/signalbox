import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";

type Done = { readonly done: true; readonly value: unknown };
export type MockWorkflow = {
  $arm: (...args: ReadonlyArray<unknown>) => void;
  recall: (site: string, label: string, key: string) => Promise<unknown>;
  remember: (site: string, label: string, key: string, value: unknown) => Promise<void>;
  agent: (site: string, label: string, options: unknown) => Promise<unknown>;
  call: (site: string, label: string, operation: string, args: unknown) => Promise<unknown>;
  ask: (site: string, label: string, options: unknown) => Promise<unknown>;
  notify: (site: string, label: string, message: string) => Promise<void>;
  start: (site: string, label: string, name: string, input: unknown) => Promise<void>;
  waitFor: (site: string, label: string, options: unknown) => Promise<unknown>;
  eventCursor: (site: string, label: string) => Promise<{ runId: string; sequence: number }>;
  done: (value: unknown) => Done;
  repeat: (
    site: string,
    label: string,
    options: { readonly max: number },
    body: (w: MockWorkflow) => Promise<unknown>,
  ) => Promise<Done | { readonly done: false }>;
};

type CompiledBody = (w: MockWorkflow, input: unknown, trigger: unknown) => Promise<unknown>;
export type CostWorkflow = (w: MockWorkflow, input: unknown, trigger: unknown) => Promise<unknown>;

export const candidateWorkflow = async (source: string): Promise<CostWorkflow> => {
  const compiled = compileForCloud(source);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const workerModule = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.compiled.workerModule).toString("base64")}`
  );
  const load = workerModule.load as (
    workflow: (body: CompiledBody) => CompiledBody,
  ) => CompiledBody;
  return load((body) => body);
};

export const makeHost = (input: {
  readonly agents: Array<unknown>;
  readonly pr?: unknown;
  readonly reads?: Array<unknown>;
  readonly direction?: string | null;
}) => {
  const memory = new Map<string, unknown>([
    ["sync-pr", input.pr ?? null],
    ["sync-direction", input.direction ?? null],
  ]);
  const calls: Array<ReadonlyArray<unknown>> = [];
  let release: ((value: unknown) => void) | undefined;
  let reached = () => {};
  const asking = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const w: MockWorkflow = {
    $arm: () => {},
    async recall(_site, _label, key) {
      return memory.get(key);
    },
    async remember(_site, label, key, value) {
      calls.push(["remember", label, key, value]);
      memory.set(key, value);
    },
    async agent(_site, label, options) {
      calls.push(["agent", label, options]);
      const result = input.agents.shift();
      if (result === undefined) throw new Error("No scripted agent result remains.");
      return result;
    },
    async call(_site, _label, _operation, args) {
      calls.push(["read", args]);
      const result = input.reads?.shift();
      if (result === undefined) throw new Error("No scripted pull request read remains.");
      return result;
    },
    async ask(_site, label, options) {
      calls.push(["ask", label, options]);
      reached();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    async notify(...args) {
      calls.push(["notify", ...args]);
    },
    async start(...args) {
      calls.push(["start", ...args]);
    },
    async waitFor(...args) {
      calls.push(["wait", ...args]);
    },
    async eventCursor(_site, label) {
      calls.push(["cursor", label]);
      return { runId: "run-1", sequence: 0 };
    },
    done(value) {
      return { done: true, value };
    },
    async repeat(_site, _label, { max }, body) {
      for (let index = 0; index < max; index++) {
        const result = await body(w);
        if (result && typeof result === "object" && "done" in result && result.done === true) {
          return { done: true, value: "value" in result ? result.value : undefined };
        }
      }
      return { done: false };
    },
  };
  return {
    w,
    memory,
    calls,
    asking,
    answer: (direction: string) => {
      if (!release) throw new Error("No question is waiting for an answer.");
      release({ choice: "submit", values: { direction } });
    },
  };
};
