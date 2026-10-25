import type { ViteUserConfig } from "vite-plus";

type LintOverride = NonNullable<NonNullable<ViteUserConfig["lint"]>["overrides"]>[number];

const overrides: Array<LintOverride> = [
  {
    files: ["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
    rules: { "signalbox/no-effect-expression-body": "error" },
  },
];

export default { jsPlugins: ["./packages/oxlint-plugin-signalbox/index.ts"], overrides };
