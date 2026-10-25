import type { KernelProgramHost } from "../../../kernel/KernelProgramHost.ts";

export type GuestExecutableResolution =
  | { readonly status: "found" | "missing"; readonly executable: string }
  | { readonly status: "error"; readonly executable: string; readonly error: unknown };

export function resolveGuestExecutable(
  host: Pick<KernelProgramHost, "resolve">,
  command: string,
  options: { readonly cwd: string; readonly baseCwd: string; readonly PATH: string | undefined },
): GuestExecutableResolution {
  const cwd = resolveGuestPath(options.cwd, options.baseCwd);
  if (command.includes("/")) return inspect(host, resolveGuestPath(command, cwd));

  if (options.PATH !== undefined) {
    for (const directory of options.PATH.split(":")) {
      const candidate = resolveGuestPath(
        directory.length === 0 ? command : `${directory}/${command}`,
        cwd,
      );
      const result = inspect(host, candidate);
      if (result.status !== "missing") return result;
    }
  }

  // Some registered kernel programs intentionally use a logical name with no path.
  return inspect(host, command);
}

function inspect(
  host: Pick<KernelProgramHost, "resolve">,
  executable: string,
): GuestExecutableResolution {
  try {
    const result = host.resolve(executable);
    if (result.status === "ok") return { status: "found", executable };
    if (result.status === "error" && result.error.code === "NOT_FOUND") {
      return { status: "missing", executable };
    }
    if (result.status === "error") return { status: "error", executable, error: result.error };
    return {
      status: "error",
      executable,
      error: new Error("Kernel executable resolution would block"),
    };
  } catch (error) {
    return { status: "error", executable, error };
  }
}

function resolveGuestPath(path: string, cwd: string): string {
  if (typeof path !== "string" || typeof cwd !== "string") {
    throw new TypeError("Guest executable paths and cwd must be strings");
  }
  const absolute = path.startsWith("/");
  if (!cwd.startsWith("/"))
    throw new TypeError("Guest executable cwd must resolve to an absolute path");

  const parts = [...(absolute ? [] : cwd.split("/")), ...path.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.length === 0 ? "/" : `/${normalized.join("/")}`;
}
