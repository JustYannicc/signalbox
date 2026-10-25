import type { KernelProgramHost } from "../../../kernel/KernelProgramHost.ts";
import type { BunShimHost } from "../../BunShim.ts";
import type { createNodeProcess } from "../../NodeProcess.ts";
import { resolveGuestExecutable } from "../childProcess/resolveExecutable.ts";

type BunProcess = Pick<ReturnType<typeof createNodeProcess>, "cwd" | "env">;
type BunWhich = NonNullable<BunShimHost["which"]>;

/** Resolves guest PATH entries only when the shared kernel registered an exact candidate. */
export function createBunWhich(
  host: Pick<KernelProgramHost, "resolve">,
  process: BunProcess,
): BunWhich {
  return (command, options) => {
    if (typeof command !== "string" || command.length === 0) return null;

    const baseCwd = process.cwd();
    const result = resolveGuestExecutable(host, command, {
      cwd: options?.cwd ?? baseCwd,
      baseCwd,
      PATH: options?.PATH ?? process.env.PATH,
    });
    if (result.status === "error") throw result.error;
    return result.status === "found" ? result.executable : null;
  };
}
