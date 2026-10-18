import { assert, it } from "@effect/vitest";

import { openCodeModelPricing } from "@t3tools/provider-opencode/server/modelPricing";

it("reads object and array cost shapes while keeping zero valid", () => {
  assert.deepStrictEqual(openCodeModelPricing({ input: 3, output: 15 }), {
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
  });
  assert.deepStrictEqual(openCodeModelPricing([{ input: 0, output: 0 }]), {
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
  });
  assert.isUndefined(openCodeModelPricing({ input: 3 }));
});
