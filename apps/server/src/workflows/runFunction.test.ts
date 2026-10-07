import { describe, expect, it } from "vite-plus/test";

import { importedPackages } from "./runFunction.ts";

describe("importedPackages", () => {
  it("lists the packages a run module imports, not strings that look like them", () => {
    const module = `import { PDFDocument } from "pdf-lib";
import dayjs from 'dayjs/esm/index.js';
import * as zod from "@scope/pkg/sub";
import "side-effect";
import { readFile } from "node:fs/promises";
import local from "./local.js";
export { thing } from "re-export";
const meta = { name: "Run code" };
const lazy = await import("lazy-pkg");
export const description = "import from 'nope'";
`;
    expect(importedPackages(module)).toEqual([
      "@scope/pkg",
      "dayjs",
      "lazy-pkg",
      "pdf-lib",
      "re-export",
      "side-effect",
    ]);
  });
});
