import type { ModelPricing } from "@t3tools/contracts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** OpenCode v1 reports a cost object; v2 reports a one-entry cost array. */
export function openCodeModelPricing(cost: unknown): ModelPricing | undefined {
  const entry = record(Array.isArray(cost) ? cost[0] : cost);
  const input = entry?.input;
  const output = entry?.output;
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isFinite(output) ||
    output < 0
  ) {
    return undefined;
  }
  return {
    inputCostPerMillionTokens: input,
    outputCostPerMillionTokens: output,
  };
}
