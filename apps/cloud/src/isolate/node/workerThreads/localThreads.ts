import { NodeWorkerPortBroker } from "./portBroker.ts";
import { NodeWorkerPorts } from "./portRuntime.ts";
import type { NodeWorkerPortContext } from "./portRuntime.ts";
import { createNodeWorkerThreadsWithPorts } from "./worker.ts";
import type { CreateNodeWorkerThreadsOptions } from "./worker.ts";
import type {
  NodeWorkerModuleLoader,
  NodeWorkerStartRequest,
  NodeWorkerSupervisor,
  NodeWorkerThreadContext,
} from "./workerProtocol.ts";

type LocalPortOwnerContext = {
  readonly owner: string;
  readonly onReferenceChange?: () => void;
};

type ParentLocalThreadContext = Omit<NodeWorkerThreadContext, "ports"> & LocalPortOwnerContext;
type OpenLocalThreadContext = Pick<NodeWorkerThreadContext, "allocateThreadId" | "output"> &
  LocalPortOwnerContext;

export interface CreateNodeLocalWorkerThreadsOptions {
  readonly broker: NodeWorkerPortBroker;
  readonly supervisor: NodeWorkerSupervisor;
  readonly moduleLoader: NodeWorkerModuleLoader;
  readonly context: ParentLocalThreadContext;
}

export interface OpenNodeLocalWorkerThreadOptions {
  readonly broker: NodeWorkerPortBroker;
  readonly supervisor: NodeWorkerSupervisor;
  readonly moduleLoader: NodeWorkerModuleLoader;
  readonly context: OpenLocalThreadContext;
  readonly request: NodeWorkerStartRequest;
}

function createLocalPortRuntime(
  broker: NodeWorkerPortBroker,
  { owner, onReferenceChange }: LocalPortOwnerContext,
) {
  let connected = false;
  const portContext: NodeWorkerPortContext = {
    owner,
    connect: async (receiver) => {
      const connection = broker.connect(owner, receiver);
      connected = true;
      return connection;
    },
    disconnect: async () => {
      if (!connected) return;
      connected = false;
      await broker.disconnect(owner);
    },
    ...(onReferenceChange === undefined ? {} : { onReferenceChange }),
  };
  return {
    portContext,
    ports: new NodeWorkerPorts(portContext, { sharedMemory: "same-isolate" }),
  };
}

function validateLocalInputs(
  broker: NodeWorkerPortBroker,
  supervisor: NodeWorkerSupervisor,
  moduleLoader: NodeWorkerModuleLoader,
): void {
  if (!(broker instanceof NodeWorkerPortBroker)) {
    throw new TypeError("Local worker_threads requires a local NodeWorkerPortBroker");
  }
  if (!supervisor || typeof supervisor.start !== "function")
    throw new TypeError("worker_threads requires a supervisor");
  if (!moduleLoader || typeof moduleLoader.resolve !== "function" || !moduleLoader.reference)
    throw new TypeError("worker_threads requires a verified module loader");
}

function verifyRequestGraph(
  request: NodeWorkerStartRequest,
  moduleLoader: NodeWorkerModuleLoader,
): void {
  const reference = moduleLoader.reference;
  if (
    request.graph.artifactRef !== reference.artifactRef ||
    request.graph.artifactHash !== reference.artifactHash ||
    request.graph.sourceIdentity !== reference.sourceIdentity
  ) {
    throw new Error("worker graph identity was not verified");
  }
}

export function createNodeLocalWorkerThreads({
  broker,
  supervisor,
  moduleLoader,
  context,
}: CreateNodeLocalWorkerThreadsOptions) {
  validateLocalInputs(broker, supervisor, moduleLoader);
  if (
    !context ||
    typeof context.allocateThreadId !== "function" ||
    typeof context.output !== "function"
  )
    throw new TypeError("worker_threads requires a process context");

  const { owner, onReferenceChange, ...threadContext } = context;
  const { portContext, ports } = createLocalPortRuntime(broker, {
    owner,
    ...(onReferenceChange === undefined ? {} : { onReferenceChange }),
  });
  const options: CreateNodeWorkerThreadsOptions = {
    supervisor,
    moduleLoader,
    context: { ...threadContext, ports: portContext },
  };
  return createNodeWorkerThreadsWithPorts(options, ports);
}

export async function openNodeLocalWorkerThread({
  broker,
  supervisor,
  moduleLoader,
  context,
  request,
}: OpenNodeLocalWorkerThreadOptions) {
  validateLocalInputs(broker, supervisor, moduleLoader);
  if (
    !context ||
    typeof context.allocateThreadId !== "function" ||
    typeof context.output !== "function"
  )
    throw new TypeError("worker_threads requires a process context");
  verifyRequestGraph(request, moduleLoader);

  const { portContext, ports } = createLocalPortRuntime(broker, context);
  try {
    await ports.drain();
    const startInput = request.input.value;
    if (startInput === null || typeof startInput !== "object")
      throw new TypeError("Worker start packet is invalid");
    const parentMarker = Reflect.get(startInput, "parentPort");
    const parentEntries = request.input.ports.filter(({ marker }) => marker === parentMarker);
    if (parentEntries.length !== 1)
      throw new TypeError("Worker start packet must transfer its parentPort exactly once");
    const parentEntry = parentEntries[0]!;

    await broker.transfer(request.owner, context.owner, request.input);
    const workerData = ports.decode({
      ...request.input,
      value: Reflect.get(startInput, "workerData"),
      ports: request.input.ports.filter(({ marker }) => marker !== parentMarker),
    });
    const environmentEntries = ports.decode(request.environmentData) as readonly (readonly [
      unknown,
      unknown,
    ])[];
    return createNodeWorkerThreadsWithPorts(
      {
        supervisor,
        moduleLoader,
        context: {
          ports: portContext,
          threadId: request.threadId,
          isMainThread: false,
          parentPort: { id: parentEntry.handle.id, lease: parentEntry.handle.lease },
          workerData,
          environmentData: new Map(environmentEntries),
          env: request.env,
          argv: request.argv,
          execArgv: request.execArgv,
          resourceLimits: request.resourceLimits,
          allocateThreadId: context.allocateThreadId,
          output: context.output,
        },
      },
      ports,
    );
  } catch (error) {
    try {
      await ports.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Local worker thread bootstrap failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
