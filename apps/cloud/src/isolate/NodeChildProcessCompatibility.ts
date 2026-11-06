export {
  normalizeSignal,
  signalName,
  normalizeSpawn,
  normalizeShellCommand,
  isArgumentList,
} from "./node/childProcess/arguments.ts";
export { abortError, asChildProcessError } from "./node/childProcess/errors.ts";
export { createExecMethods } from "./node/childProcess/exec.ts";
export { unsupportedNodeOperation } from "./node/process/NodeError.ts";
