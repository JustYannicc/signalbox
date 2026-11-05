import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { rpcStubOwner } from "../rpc/Resources.ts";
import type {
  ClaudeCliProcessPort,
  ClaudeSdkHostService,
  ClaudeSdkProcessContext,
} from "./ClaudeSdkHostProtocol.ts";

interface SdkHostProps {
  readonly name: string;
  readonly code: WorkerLoaderWorkerCode;
}

/** Loader environment bindings must reference a statically exported entrypoint.
 * Dynamic entrypoints and transient RpcTargets cannot be serialized into them. */
export class ClaudeSdkHostLoader extends WorkerEntrypoint<
  { readonly LOADER: WorkerLoader },
  SdkHostProps
> {
  async open(input: unknown, context: ClaudeSdkProcessContext, process: ClaudeCliProcessPort) {
    const worker = this.env.LOADER.get(this.ctx.props.name, () => this.ctx.props.code);
    const entrypoint = worker.getEntrypoint() as unknown as ClaudeSdkHostService;
    using _owner = rpcStubOwner(entrypoint);
    return await entrypoint.open(input, context, process);
  }
}

export function loadClaudeSdkHost(
  name: string,
  code: WorkerLoaderWorkerCode,
): ClaudeSdkHostService {
  const bindings = exports as unknown as {
    readonly ClaudeSdkHostLoader: (options: {
      readonly props: SdkHostProps;
    }) => ClaudeSdkHostService;
  };
  return bindings.ClaudeSdkHostLoader({ props: { name, code } });
}
