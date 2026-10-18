import { compileWorkflow } from "./compileWorkflow.ts";
import { forCloud } from "./forCloud.ts";

export type { CompileForCloudResult } from "./forCloud.ts";

/** Native Node/CLI compilation, with the same artifact format as the cloud compiler. */
export function compileForCloud(source: string) {
  return forCloud(compileWorkflow(source));
}
