import { ABI_VERSION } from "../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import { KERNEL_BASH_ARTIFACT } from "../kernel/KernelProgramArtifacts.ts";
import { KERNEL_RIPGREP_PROGRAM_MANIFEST } from "../kernel/KernelProgramArtifacts.ts";
import { KERNEL_COREUTILS_VERSION } from "../kernel/KernelProgramArtifacts.ts";
import { KERNEL_GIT_PROGRAM_MANIFEST } from "../kernel/KernelProgramArtifacts.ts";
import {
  KERNEL_BUSYBOX_VERSION,
  PRODUCT_COMPUTER_BUSYBOX_VERSION,
} from "../kernel/KernelProgramArtifacts.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../kernel/KernelGnuPrograms.ts";
import { KERNEL_JQ_ARTIFACT } from "../kernel/KernelJqProgram.ts";
import { KERNEL_UGREP_ARTIFACT } from "../kernel/KernelUgrepProgram.ts";
import {
  CHILD_BUSYBOX_APPLETS,
  CHILD_PRODUCT_BUSYBOX_APPLETS,
  CHILD_COREUTILS_COMMANDS,
  CHILD_UGREP_EXECUTABLES,
} from "./ChildProgramSet.ts";
import { childProgramPaths } from "./ChildProgramPaths.ts";
import type { ChildProgramCodes } from "./ChildProgramCodes.ts";
import type { ChildWorkerCode } from "./ChildWorkerCode.ts";

export type ComputerProgramHostKind = "bash" | "syscall" | "busybox" | "coreutils" | "git";
export interface ComputerCatalogProgram {
  readonly executable: string;
  readonly implementation: string;
  readonly manifest: KernelProgramBinding["manifest"];
  readonly code: ChildWorkerCode;
  readonly hostKind: ComputerProgramHostKind;
  readonly sigpipe?: "epipe";
  readonly pwd?: true;
}

/** One catalog supplies both local kernel registrations and Computer's execution owner. */
export function createComputerProgramCatalog(codes: ChildProgramCodes) {
  const programs = new Map<string, ComputerCatalogProgram>();
  const aliases = new Set<string>();
  const manifest = (name: string, version: string, entrypoint: string) =>
    Object.freeze({
      name,
      version,
      abiVersion: ABI_VERSION,
      requiredCapabilities: Object.freeze([]),
      entrypoint,
    });
  const add = (
    executable: string,
    code: ChildWorkerCode,
    hostKind: ComputerProgramHostKind,
    pin: ComputerCatalogProgram["manifest"],
    extras: Pick<ComputerCatalogProgram, "sigpipe" | "pwd"> = {},
  ) => {
    programs.set(
      executable,
      Object.freeze({
        executable,
        implementation: executable,
        code,
        hostKind,
        manifest: pin,
        ...extras,
      }),
    );
  };
  const bash = Object.freeze({
    ...manifest(
      "@nimbus/bash",
      KERNEL_BASH_ARTIFACT.version,
      `nimbus-bash:${KERNEL_BASH_ARTIFACT.sha256}`,
    ),
    requiredCapabilities: Object.freeze([
      "process.spawn" as const,
      "process.wait" as const,
      "process.signal" as const,
    ]),
  });
  add("/bin/bash", codes.bash, "bash", bash);
  programs.set(
    "/bin/sh",
    Object.freeze({
      ...programs.get("/bin/bash")!,
      executable: "/bin/sh",
      manifest: Object.freeze({ ...bash, name: "@nimbus/sh" }),
    }),
  );
  const applets = (names: readonly string[], code: ChildWorkerCode, version: string) => {
    for (const name of names)
      add(
        `/bin/${name}`,
        code,
        "busybox",
        manifest(`@nimbus/busybox/${name}`, version, `busybox-${version}:${name}`),
      );
  };
  applets(
    codes.busyboxApplets === undefined ? ["cat"] : CHILD_BUSYBOX_APPLETS,
    codes.busyboxApplets ?? codes.busyboxCat,
    KERNEL_BUSYBOX_VERSION,
  );
  if (codes.productBusyboxApplets !== undefined)
    applets(
      CHILD_PRODUCT_BUSYBOX_APPLETS,
      codes.productBusyboxApplets,
      PRODUCT_COMPUTER_BUSYBOX_VERSION,
    );
  if (codes.sed !== undefined)
    add(
      "/bin/sed",
      codes.sed,
      "busybox",
      manifest(
        "@gnu/sed",
        KERNEL_GNU_SED_ARTIFACT.version,
        `gnu-sed:${KERNEL_GNU_SED_ARTIFACT.sha256}`,
      ),
    );
  if (codes.ugrep !== undefined)
    for (const executable of CHILD_UGREP_EXECUTABLES)
      add(
        executable,
        codes.ugrep,
        "busybox",
        manifest(
          executable === "/bin/ugrep" ? "@ugrep/ugrep" : "@ugrep/ugrep:claude-multicall",
          KERNEL_UGREP_ARTIFACT.version,
          `ugrep:${KERNEL_UGREP_ARTIFACT.sha256}`,
        ),
      );
  add("/bin/rg", codes.ripgrep, "syscall", KERNEL_RIPGREP_PROGRAM_MANIFEST, {
    sigpipe: "epipe",
    pwd: true,
  });
  for (const command of CHILD_COREUTILS_COMMANDS) {
    const code = codes.coreutils?.[command];
    if (code !== undefined)
      add(
        `/bin/${command}`,
        code,
        "coreutils",
        manifest(
          `@agentos-software/coreutils/${command}`,
          KERNEL_COREUTILS_VERSION,
          `coreutils-${KERNEL_COREUTILS_VERSION}:${command}`,
        ),
        { pwd: true },
      );
  }
  if (codes.jq !== undefined)
    add(
      "/usr/bin/jq",
      codes.jq,
      "coreutils",
      manifest(
        "@agentos-software/jq",
        KERNEL_JQ_ARTIFACT.version,
        `agentos-jq-${KERNEL_JQ_ARTIFACT.version}:${KERNEL_JQ_ARTIFACT.sha256}`,
      ),
      { pwd: true },
    );
  if (codes.git !== undefined) add("/usr/bin/git", codes.git, "git", KERNEL_GIT_PROGRAM_MANIFEST);
  const primaryPrograms = Array.from(programs);
  for (const [executable, program] of primaryPrograms)
    for (const alias of childProgramPaths(executable)) {
      if (programs.has(alias)) continue;
      programs.set(
        alias,
        Object.freeze({
          ...program,
          executable: alias,
          manifest: Object.freeze({
            ...program.manifest,
            name: `${program.manifest.name}:path:${alias}`,
          }),
        }),
      );
      aliases.add(alias);
    }
  return { programs, aliases };
}
