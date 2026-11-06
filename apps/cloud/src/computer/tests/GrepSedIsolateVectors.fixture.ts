import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";

export type GrepSedVector = {
  readonly id: number;
  readonly executable: "/bin/grep" | "/bin/sed";
  readonly argv: readonly string[];
  readonly pathReplacements: Readonly<Record<number, string>>;
  readonly files: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly expectedStdout: string;
  readonly expectedExitCode: number;
  readonly editedFile?: string;
  readonly editedContents?: string;
};

function textLines(prefix: string, count: number) {
  return (
    Array.from({ length: count }, (_, index) => prefix + String(index + 1).padStart(2, "0")).join(
      "\n",
    ) + "\n"
  );
}

export const GREP_SED_VECTORS: readonly GrepSedVector[] = [
  {
    id: 1,
    executable: "/bin/grep",
    argv: ["grep", "-n", "uiWords\\|language", "anon-1/a.txt", "anon-1/b.txt", "anon-1/c.txt"],
    pathReplacements: { 3: "anon-1/a.txt", 4: "anon-1/b.txt", 5: "anon-1/c.txt" },
    files: {
      "anon-1/a.txt": "plain\nuiWords scene\nother\n",
      "anon-1/b.txt": "language selected\nuiWords language mixed\n",
      "anon-1/c.txt": "nothing here\n",
    },
    stdin: "",
    expectedStdout:
      "anon-1/a.txt:2:uiWords scene\nanon-1/b.txt:1:language selected\nanon-1/b.txt:2:uiWords language mixed\n",
    expectedExitCode: 0,
  },
  {
    id: 2,
    executable: "/bin/grep",
    argv: ["grep", "-v", "Rendering frames"],
    pathReplacements: {},
    files: {},
    stdin: "Rendering frames start\nkeep alpha\nrendering frames lower-case\nkeep omega\n",
    expectedStdout: "keep alpha\nrendering frames lower-case\nkeep omega\n",
    expectedExitCode: 0,
  },
  {
    id: 3,
    executable: "/bin/grep",
    argv: ["grep", "-E", "max_volume|mean_volume|^\\s+I:|Peak:"],
    pathReplacements: {},
    files: {},
    stdin: "max_volume: 0.8\nmean_volume: 0.4\n  I: input\nPeak: loud\nquiet\n",
    expectedStdout: "max_volume: 0.8\nmean_volume: 0.4\n  I: input\nPeak: loud\n",
    expectedExitCode: 0,
  },
  {
    id: 4,
    executable: "/bin/grep",
    argv: ["grep", "-v", "Rendering frames", "anon-4/render.log"],
    pathReplacements: { 3: "anon-4/render.log" },
    files: {
      "anon-4/render.log": "Rendering frames 1\nkeep alpha\nRendering frames 2\nkeep omega\n",
    },
    stdin: "",
    expectedStdout: "keep alpha\nkeep omega\n",
    expectedExitCode: 0,
  },
  {
    id: 5,
    executable: "/bin/grep",
    argv: [
      "grep",
      "-rn",
      "dithered-design\\|ansi-shadow\\|optional",
      "--include=*.md",
      "--include=*.json",
      "--include=*.sh",
      ".",
    ],
    pathReplacements: {},
    files: {
      "docs/one.md": "no match\noptional text\n",
      "data/two.json": '{"schema":"dithered-design"}\n',
      "scripts/three.sh": "# ansi-shadow\n",
      "docs/skip.txt": "optional excluded\n",
    },
    stdin: "",
    expectedStdout:
      './data/two.json:1:{"schema":"dithered-design"}\n./docs/one.md:2:optional text\n./scripts/three.sh:1:# ansi-shadow\n',
    expectedExitCode: 0,
  },
  {
    id: 6,
    executable: "/bin/grep",
    argv: ["grep", "-v", "^./skills/dithered\\|^./skills/ansi"],
    pathReplacements: {},
    files: {},
    stdin: "./skills/dithered/guide.md\n./skills/ansi/title.md\nkeep first\nkeep second\n",
    expectedStdout: "keep first\nkeep second\n",
    expectedExitCode: 0,
  },
  {
    id: 7,
    executable: "/bin/sed",
    argv: ["sed", "-n", "1,40p", "anon-7/input.txt"],
    pathReplacements: { 3: "anon-7/input.txt" },
    files: { "anon-7/input.txt": textLines("line-", 45) },
    stdin: "",
    expectedStdout: textLines("line-", 40),
    expectedExitCode: 0,
  },
  {
    id: 8,
    executable: "/bin/grep",
    argv: ["grep", "-n", "customRenderer\\|builtIn", "anon-8/a.txt", "anon-8/b.txt"],
    pathReplacements: { 3: "anon-8/a.txt", 4: "anon-8/b.txt" },
    files: {
      "anon-8/a.txt": "none\ncustomRenderer = true\n",
      "anon-8/b.txt": "builtIn = false\nother\n",
    },
    stdin: "",
    expectedStdout: "anon-8/a.txt:2:customRenderer = true\nanon-8/b.txt:1:builtIn = false\n",
    expectedExitCode: 0,
  },
  {
    id: 9,
    executable: "/bin/sed",
    argv: [
      "sed",
      "-i",
      "",
      "s/They sit outside the standard systems profile and keep their renderer and voice models in a cache, not in this repository\\./They sit outside the standard systems profile and install their renderer and voice model into a cache on first run./",
      "anon-9/README.md",
    ],
    pathReplacements: { 4: "anon-9/README.md" },
    files: {
      "anon-9/README.md":
        "They sit outside the standard systems profile and keep their renderer and voice models in a cache, not in this repository.\nleave this line alone\n",
    },
    stdin: "",
    expectedStdout: "",
    expectedExitCode: 0,
    editedFile: "anon-9/README.md",
    editedContents:
      "They sit outside the standard systems profile and install their renderer and voice model into a cache on first run.\nleave this line alone\n",
  },
];

export function expectedPin(vector: GrepSedVector) {
  return vector.executable === "/bin/sed" ? KERNEL_GNU_SED_ARTIFACT : KERNEL_UGREP_ARTIFACT;
}

export function expectedChildArgv(vector: GrepSedVector): readonly (readonly string[])[] {
  if (vector.executable === "/bin/grep") {
    const args = [...vector.argv];
    let options = true;
    let pattern = false;
    let recursive = false;
    const operandIndexes: number[] = [];
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!;
      if (options && argument === "--") {
        options = false;
        continue;
      }
      if (options && (argument === "--include" || argument === "--exclude-dir")) {
        index++;
        continue;
      }
      if (options && (argument.startsWith("--include=") || argument.startsWith("--exclude-dir="))) {
        continue;
      }
      if (options && /^-A\d{1,3}$/.test(argument) && Number(argument.slice(2)) <= 100) continue;
      if (options && /^-[GEilnvr]+$/.test(argument)) {
        recursive ||= argument.includes("r");
        continue;
      }
      if (!pattern) {
        pattern = true;
        continue;
      }
      operandIndexes.push(index);
    }
    const dotRoots = operandIndexes.filter((index) => args[index] === ".");
    if (recursive && dotRoots.length > 0 && operandIndexes.length > 1) {
      const operands = new Set(operandIndexes);
      return operandIndexes.map((operandIndex) => {
        const operand = args[operandIndex]!;
        const rootArgs = args.filter((_, index) => !operands.has(index) || index === operandIndex);
        const rootFormat = operand === "." ? ["--format=./%F%N%O%~"] : [];
        return [rootArgs[0]!, "--jobs=1", ...rootFormat, "-H", ...rootArgs.slice(1)];
      });
    }
    const rootFormat =
      recursive && operandIndexes.length === 1 && args[operandIndexes[0]!] === "."
        ? ["--format=./%F%N%O%~"]
        : [];
    return [[args[0]!, "--jobs=1", ...rootFormat, ...args.slice(1)]];
  }
  if (vector.id !== 9) return [vector.argv];
  return [["sed", "-i", vector.argv[3]!, vector.argv[4]!]];
}

export function errorDetails(error: unknown) {
  const details: Record<string, string> = {};
  if (typeof error === "object" && error !== null) {
    for (const key of ["name", "message", "code", "errno", "syscall", "path", "cause"]) {
      const value = Reflect.get(error, key);
      if (value !== undefined) details[key] = String(value);
    }
  }
  if (details.message === undefined) details.message = String(error);
  return details;
}

interface VectorWorkspace {
  readonly filesystem: {
    chdir(path: string): void;
    mkdir(path: string): void;
  };
  write(path: string, contents: string): void;
}

export function prepareVectorWorkspace(
  fixture: VectorWorkspace,
  files: Readonly<Record<string, string>>,
) {
  const created = new Set(["/"]);
  mkdirs(fixture, "/work", created);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = "/work/" + relativePath;
    const parent = absolute.slice(0, absolute.lastIndexOf("/"));
    mkdirs(fixture, parent, created);
    fixture.write(absolute, contents);
  }
  fixture.filesystem.chdir("/work");
}

function mkdirs(fixture: VectorWorkspace, directory: string, created: Set<string>) {
  let path = "";
  for (const part of directory.split("/").filter(Boolean)) {
    path += "/" + part;
    if (created.has(path)) continue;
    fixture.filesystem.mkdir(path);
    created.add(path);
  }
}
