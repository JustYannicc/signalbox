import type { ChildWorkerCode } from "./ChildWorkerCode.ts";
import type { ChildCoreutilsCommand } from "./ChildProgramSet.ts";
import type { CodeModeCellCode } from "../codeMode/Types.ts";

export interface ChildProgramCodes {
  readonly bash: ChildWorkerCode;
  readonly busyboxCat: ChildWorkerCode;
  readonly busyboxApplets?: ChildWorkerCode;
  readonly productBusyboxApplets?: ChildWorkerCode;
  readonly ripgrep: ChildWorkerCode;
  readonly coreutils?: Partial<Readonly<Record<ChildCoreutilsCommand, ChildWorkerCode>>>;
  readonly git?: ChildWorkerCode;
  readonly sed?: ChildWorkerCode;
  readonly jq?: ChildWorkerCode;
  readonly ugrep?: ChildWorkerCode;
  readonly codeMode?: CodeModeCellCode;
}

export const CHILD_PROGRAM_CODE_NAMES = Object.freeze(
  Object.keys({
    bash: true,
    busyboxCat: true,
    busyboxApplets: true,
    productBusyboxApplets: true,
    ripgrep: true,
    coreutils: true,
    git: true,
    sed: true,
    jq: true,
    ugrep: true,
    codeMode: true,
  } satisfies Record<keyof ChildProgramCodes, true>),
);
