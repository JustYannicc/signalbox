import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["measure.test.ts"],
    maxWorkers: 2,
    fileParallelism: false,
    testTimeout: 240000,
  },
});
