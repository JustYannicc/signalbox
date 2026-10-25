import { definePlugin } from "@oxlint/plugins";

import noEffectExpressionBody from "./rules/no-effect-expression-body.ts";

export default definePlugin({
  meta: { name: "signalbox" },
  rules: { "no-effect-expression-body": noEffectExpressionBody },
});
