export const KERNEL_GIT_MAX_PATH_BYTES = 1_048_576;
export const KERNEL_GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type KernelGitNamespace = "nimbus_fs" | "nimbus_proc";

type KernelGitMemoryPlan = (
  args: readonly number[],
  memorySize: number,
  addRange: (pointer: number, length: number) => void,
) => void;

const noMemory: KernelGitMemoryPlan = () => {};

function argument(args: readonly number[], index: number): number {
  const value = args[index];
  if (value === undefined) throw new TypeError("Git Nimbus imports use only 32-bit arguments");
  return value;
}

function addPath(
  args: readonly number[],
  pointerIndex: number,
  lengthIndex: number,
  addRange: (pointer: number, length: number) => void,
): void {
  const size = argument(args, lengthIndex) >>> 0;
  if (size <= KERNEL_GIT_MAX_PATH_BYTES) addRange(argument(args, pointerIndex), size);
}

const plans: Readonly<Record<KernelGitNamespace, Readonly<Record<string, KernelGitMemoryPlan>>>> = {
  nimbus_fs: {
    path_stat: (args, _memorySize, addRange) => {
      addPath(args, 2, 3, addRange);
      addRange(argument(args, 4), 80);
    },
    fd_stat: (args, _memorySize, addRange) => addRange(argument(args, 1), 80),
    path_chmod: (args, _memorySize, addRange) => addPath(args, 2, 3, addRange),
    fd_chmod: noMemory,
    umask: (args, _memorySize, addRange) => addRange(argument(args, 1), 4),
    path_access: (args, _memorySize, addRange) => addPath(args, 2, 3, addRange),
  },
  nimbus_proc: {
    ids: (args, _memorySize, addRange) => addRange(argument(args, 0), 8),
    startup_cwd: (args, memorySize, addRange) => {
      const start = argument(args, 0) >>> 0;
      const capacity = argument(args, 1) >>> 0;
      if (capacity === 0 || start >= memorySize) return;
      addRange(start, Math.min(capacity, memorySize - start, KERNEL_GIT_MAX_PATH_BYTES));
    },
    pipe: (args, _memorySize, addRange) => addRange(argument(args, 0), 8),
    dup: (args, _memorySize, addRange) => addRange(argument(args, 1), 4),
    dup2: noMemory,
    kill: noMemory,
    wait: (args, _memorySize, addRange) => {
      addRange(argument(args, 2), 4);
      addRange(argument(args, 3), 4);
    },
    spawn: (args, _memorySize, addRange) => {
      for (const index of [1, 3, 5]) {
        if (argument(args, index) >>> 0 <= KERNEL_GIT_MAX_BUFFER_BYTES)
          addRange(argument(args, index - 1), argument(args, index));
      }
      addRange(argument(args, 9), 4);
    },
    start: noMemory,
  },
};

export function hasKernelGitMemoryPlan(namespace: KernelGitNamespace, name: string): boolean {
  return Object.hasOwn(plans[namespace], name);
}

export function planKernelGitMemory(
  namespace: KernelGitNamespace,
  name: string,
  args: readonly number[],
  memorySize: number,
  addRange: (pointer: number, length: number) => void,
): void {
  if (!hasKernelGitMemoryPlan(namespace, name))
    throw new TypeError(`Unsupported Git import ${namespace}.${name}`);
  plans[namespace][name]!(args, memorySize, addRange);
}
