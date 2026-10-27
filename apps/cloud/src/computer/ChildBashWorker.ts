import { createChildBash, type ChildBashOptions } from "./ChildBash.ts";
import { ChildBashForkSource } from "./ChildBashForkSource.ts";

export function createWorkerChildBash(options: ChildBashOptions) {
  return createChildBash({
    ...options,
    createForkSource: (source) => new ChildBashForkSource(source),
  });
}
