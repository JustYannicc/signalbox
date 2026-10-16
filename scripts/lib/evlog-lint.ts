/**
 * Signalbox code that logs through evlog (#285) fails lint on any other sink:
 * `console.*` and the usual logger packages. `vite.config.ts` spreads these
 * into its overrides. Effect code is covered too, since `Effect.log*` reaches
 * evlog through the logger layer; the Effect language service already flags
 * `console` inside Effect.
 */

/** Signalbox-owned code that emits wide events. Grows as each surface moves to evlog. */
const COVERED = ["apps/cloud/src/**", "apps/cloud/evlog.config.ts"];

/** Scripts whose console is their interface, such as `curl … | node -` setups. */
const CONSOLE_INTERFACES = ["apps/cloud/src/localKeys/localSetup.ts"];

const OTHER_LOGGERS = [
  "pino",
  "winston",
  "bunyan",
  "consola",
  "debug",
  "loglevel",
  "log4js",
  "signale",
  "roarr",
  "@logtape/logtape",
].map((name) => ({
  name,
  message: "Log through evlog: see apps/cloud/src/observability/Evlog.ts.",
}));

/** `restrictedImports`: the paths the base config restricts, which an override replaces. */
export const evlogLintOverrides = (restrictedImports: ReadonlyArray<unknown>) => [
  {
    files: COVERED,
    excludeFiles: [...CONSOLE_INTERFACES, "**/*.test.ts"],
    rules: {
      "eslint/no-console": "error",
      "eslint/no-restricted-imports": [
        "error",
        { paths: [...restrictedImports, ...OTHER_LOGGERS] },
      ],
    },
  },
];
