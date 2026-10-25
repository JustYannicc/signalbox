import { HttpNetworkBridge } from "./httpNetwork/HttpNetworkBridge.ts";
import type {
  KernelHttpNetworkHostOptions,
  KernelHttpNetworkImports,
} from "./httpNetwork/Types.ts";

export type {
  KernelHttpNetworkHostOptions,
  KernelHttpNetworkImports,
} from "./httpNetwork/Types.ts";

/** AgentOS host_net sockets carry HTTP/1.1 over the owner's verified fetch transport. */
export class KernelHttpNetworkHost {
  readonly imports: KernelHttpNetworkImports;
  readonly #bridge: HttpNetworkBridge;

  constructor(options: KernelHttpNetworkHostOptions) {
    this.#bridge = new HttpNetworkBridge(options);
    this.imports = this.#bridge.imports;
  }

  getImportObject(): { host_net: WebAssembly.ModuleImports } {
    return this.#bridge.getImportObject();
  }

  dispose(): Promise<void> {
    return this.#bridge.dispose();
  }
}
