import { createClaudeCliFacetClass } from "../../ClaudeCliSession.ts";
export const ClaudeCliFacet = createClaudeCliFacetClass(() => {
  throw new Error("Command-only fixture must not launch the CLI");
});
