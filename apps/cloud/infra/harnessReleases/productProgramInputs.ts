// @effect-diagnostics nodeBuiltinImport:off - CLI supplies pinned product program inputs.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  CHILD_PROGRAM_PATHS,
  CHILD_UGREP_EXECUTABLES,
  CHILD_COREUTILS_COMMANDS,
} from "../../src/computer/ChildProgramSet.ts";
import { childProgramPaths } from "../../src/computer/ChildProgramPaths.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import {
  KERNEL_BUSYBOX_ARTIFACT,
  PRODUCT_COMPUTER_BUSYBOX_ARTIFACT,
} from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_GIT_ARTIFACT } from "../../src/kernel/KernelGitProgram.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../src/kernel/KernelGnuPrograms.ts";
import { KERNEL_JQ_ARTIFACT } from "../../src/kernel/KernelJqProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../src/kernel/KernelUgrepProgram.ts";
import { prepareChildPrograms } from "../childPrograms/prepare.ts";
import { readPinnedGitTemplateManifest } from "../childPrograms/gitTemplateManifest.ts";

const repository = NodePath.resolve(import.meta.dirname, "../../../..");
const coreutilsProvenancePath = NodePath.join(
  repository,
  "apps/cloud/infra/kernelPrograms/coreutils/provenance.json",
);
const gitProvenancePath = NodePath.join(
  repository,
  "apps/cloud/infra/kernelPrograms/git/provenance.json",
);
const gitTemplateManifestPath = NodePath.join(
  import.meta.dirname,
  "../childPrograms/gitTemplates.manifest.json",
);

export interface ProductProgramPin {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly revision?: string;
}

export async function describeProductProgramInputs() {
  const [coreutilsProvenanceBytes, gitProvenanceBytes] = await Promise.all([
    NodeFSP.readFile(coreutilsProvenancePath),
    NodeFSP.readFile(gitProvenancePath),
  ]);
  const coreutils = JSON.parse(coreutilsProvenanceBytes.toString("utf8")) as {
    readonly commands: Readonly<Record<string, Omit<ProductProgramPin, "file">>>;
  };
  const gitProvenance = JSON.parse(gitProvenanceBytes.toString("utf8")) as {
    readonly build: {
      readonly recipe: { readonly sha256: string };
      readonly containerImage: string;
      readonly inputs: Readonly<Record<string, string>>;
    };
  };
  const [gitTemplates, gitTemplateManifestBytes] = await Promise.all([
    readPinnedGitTemplateManifest(),
    NodeFSP.readFile(gitTemplateManifestPath),
  ]);
  const gitTemplateManifest = JSON.parse(gitTemplateManifestBytes.toString("utf8")) as {
    readonly source: unknown;
    readonly directories: unknown;
  };
  const files = {
    bash: pin("bash.wasm", KERNEL_BASH_ARTIFACT),
    busybox: pin("busybox.wasm", KERNEL_BUSYBOX_ARTIFACT),
    ripgrep: pin("rg.wasm", KERNEL_RIPGREP_ARTIFACT),
    git: pin("git.wasm", KERNEL_GIT_ARTIFACT),
    sed: pin("sed.wasm", KERNEL_GNU_SED_ARTIFACT),
    jq: pin(KERNEL_JQ_ARTIFACT.preparedFile, KERNEL_JQ_ARTIFACT, KERNEL_JQ_ARTIFACT.version),
    ugrep: pin("ugrep.wasm", KERNEL_UGREP_ARTIFACT),
    productBusybox: pin(
      PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.path,
      PRODUCT_COMPUTER_BUSYBOX_ARTIFACT,
      PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.revision,
    ),
  };
  const commands = Object.fromEntries(
    CHILD_COREUTILS_COMMANDS.map((command) => {
      const value = coreutils.commands[command];
      if (!value || !Number.isSafeInteger(value.bytes) || !/^[a-f0-9]{64}$/.test(value.sha256))
        throw new Error(`PRODUCT_PROGRAM_COREUTILS_PIN_MISSING:${command}`);
      return [command, { file: `coreutils/${command}.wasm`, ...value }];
    }),
  );
  return {
    schemaVersion: 1,
    commandExecutablePaths: [
      ...new Set(
        [...Object.values(CHILD_PROGRAM_PATHS), ...CHILD_UGREP_EXECUTABLES].flatMap((path) =>
          childProgramPaths(path).slice(1),
        ),
      ),
    ].sort(),
    files,
    coreutils: { commands },
    coreutilsProvenance: {
      file: "coreutils.provenance.json",
      bytes: coreutilsProvenanceBytes.byteLength,
      sha256: NodeCrypto.createHash("sha256").update(coreutilsProvenanceBytes).digest("hex"),
    },
    gitTemplates: {
      source: gitTemplateManifest.source,
      directories: gitTemplateManifest.directories,
      files: gitTemplates.files.map((file) => ({
        ...file,
        sourceMember: `git-2.53.0/templates/${file.relativeInstallPath}`,
      })),
    },
    gitBuild: {
      recipeSha256: gitProvenance.build.recipe.sha256,
      image: gitProvenance.build.containerImage,
      inputs: gitProvenance.build.inputs,
    },
    jqPackage: {
      registryManifestUrl: new URL(
        KERNEL_JQ_ARTIFACT.registryManifestPath,
        KERNEL_JQ_ARTIFACT.registryRoot,
      ).toString(),
      packageUrl: KERNEL_JQ_ARTIFACT.packageUrl,
      packagePath: KERNEL_JQ_ARTIFACT.packagePath,
      packageBytes: KERNEL_JQ_ARTIFACT.packageBytes,
      packageSha256: KERNEL_JQ_ARTIFACT.packageSha256,
      packageEntry: KERNEL_JQ_ARTIFACT.packageEntry,
      imports: KERNEL_JQ_ARTIFACT.imports,
      exports: KERNEL_JQ_ARTIFACT.exports,
    },
  } as const;
}

function pin(
  file: string,
  artifact: { readonly bytes: number; readonly sha256: string },
  revision?: string,
): ProductProgramPin {
  return {
    file,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    ...(revision ? { revision } : {}),
  };
}

async function verify(directory: string) {
  const prepared = await prepareChildPrograms({ programDir: directory });
  return {
    schemaVersion: 1,
    commandExecutablePathCount: Object.keys(prepared.commandExecutableCatalog).length,
    commandExecutablePaths: Object.keys(prepared.commandExecutableCatalog).sort(),
    gitTemplateFileCount: prepared.dataFiles.length,
    programs: Object.keys(prepared.programs).sort(),
    coreutils: Object.keys(prepared.coreutils).sort(),
  };
}

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--describe") {
    process.stdout.write(`${JSON.stringify(await describeProductProgramInputs())}\n`);
    return;
  }
  if (argv.length === 2 && argv[0] === "--verify") {
    const directory = await NodeFSP.realpath(argv[1]!);
    process.stdout.write(`${JSON.stringify(await verify(directory))}\n`);
    return;
  }
  throw new Error("Usage: productProgramInputs.ts --describe | --verify PROGRAM_DIRECTORY");
}

if (process.argv[1] && NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]))
  await main(process.argv.slice(2));
