import type { ProductHostOptions } from "../host/product.ts";
import type { HarnessSessionHost } from "../host/contracts.ts";

/** Bootstrap supplies immutable inputs; each host owns restoring and binding its filesystem. */
export type ProductHostConfiguration<G, Native> = Pick<
  ProductHostOptions<G, Native>,
  | "threadId"
  | "programs"
  | "machineInventory"
  | "modelTransport"
  | "executor"
  | "native"
  | "filesCheckpoint"
  | "release"
>;
export type ProductBootstrapHost<G> = HarnessSessionHost<G>;
