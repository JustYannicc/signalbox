import type { ChildWorkerProgram, ChildWorkerProgramOptions } from "../ChildWorkerProgram.ts";

export type ChildProgramFactory = (
  create: (
    admission: Pick<ChildWorkerProgramOptions<object>, "reservationFor">,
  ) => ChildWorkerProgram,
) => ChildWorkerProgram;
