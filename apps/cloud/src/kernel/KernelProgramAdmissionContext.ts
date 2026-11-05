import type { KernelProgramAdmissionRequest } from "./KernelProgramAdmission.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";

export function validateKernelProgramAdmissionContext(
  request: KernelProgramAdmissionRequest,
  context: KernelAsyncProgramContext,
) {
  const command = request.command;
  const envKeys = Object.keys(command.env);
  if (
    context.processes !== request.processes ||
    !context.filesystem.sharesBackingWith(request.filesystem) ||
    (request.kind === "command" && context.filesystem.cwd !== command.cwd) ||
    context.home !== request.home ||
    context.args.length !== command.argv.length ||
    !context.args.every((value, index) => value === command.argv[index]) ||
    envKeys.length !== Object.keys(context.env).length ||
    !envKeys.every((key) => context.env[key] === command.env[key])
  ) {
    throw new TypeError("Computer process context changed after admission");
  }
  if (request.kind === "exec") {
    if (
      request.identity?.handle !== context.identity.handle ||
      request.identity.pid !== context.identity.pid ||
      request.filesystem !== context.filesystem
    ) {
      throw new TypeError("Computer replacement process identity changed");
    }
  } else {
    const parent = request.processes.info(request.parent);
    const process = context.processes.info(context.identity.handle);
    if (
      parent.status !== "ok" ||
      process.status !== "ok" ||
      process.value.parentPid !== parent.value.pid
    ) {
      throw new TypeError("Computer child process owner changed");
    }
  }
}
