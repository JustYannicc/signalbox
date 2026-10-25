import { poolObjectStub, type PoolObjectNamespace } from "../../pool/PoolDirectory.ts";
import * as ModelCompletion from "../ModelCompletion.ts";

export const layerModelCompletion = (
  bindings: { readonly pools: PoolObjectNamespace },
  options: { readonly localWorkerd: boolean },
) => ModelCompletion.layer((objectName) => poolObjectStub(bindings.pools, objectName, options));
