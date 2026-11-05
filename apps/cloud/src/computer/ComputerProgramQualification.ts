import type {
  KernelComputerAdmissionCapture,
  KernelComputerAdmissionInput,
} from "../kernel/KernelComputerAdmissionPort.ts";
import { qualifyUgrepCommand } from "./UgrepCommand.ts";
import { qualifyGnuCommandWithFiles } from "./GnuCommandCompatibility.ts";

export async function qualifyComputerProgram(
  kernel: KernelComputerAdmissionCapture,
  command: KernelComputerAdmissionInput["command"],
  signal: AbortSignal,
) {
  const ugrep = qualifyUgrepCommand(command);
  if (ugrep !== undefined) return ugrep;
  const paths = new Set<string>();
  const initial = qualifyGnuCommandWithFiles(command, (path) => {
    paths.add(path);
    return true;
  });
  if (initial.kind === "machine" || paths.size === 0) return initial;
  const observations = new Map(
    await Promise.all(
      [...paths].map(
        async (path) =>
          [
            path,
            (await kernel.canReplace?.(path.startsWith("/") ? path : `${command.cwd}/${path}`)) ??
              false,
          ] as const,
      ),
    ),
  );
  signal.throwIfAborted();
  return qualifyGnuCommandWithFiles(command, (path) => observations.get(path) === true);
}
