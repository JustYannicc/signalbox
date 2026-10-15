import { RuntimeMode } from "@t3tools/contracts";

/** Whether `mode` grants at most what `ceiling` does; runtime modes run from Supervised to full access. */
export const runtimeModeWithin = (mode: RuntimeMode, ceiling: RuntimeMode) =>
  RuntimeMode.literals.indexOf(mode) <= RuntimeMode.literals.indexOf(ceiling);
