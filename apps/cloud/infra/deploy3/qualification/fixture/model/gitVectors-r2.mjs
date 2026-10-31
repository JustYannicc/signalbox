export const GIT_VECTORS = Object.freeze({
  schema: "signalbox.1070.combined-codex-r3-host-git-truth/v1",
  sourceSeedManifestSha256: "c7347f2f8d624047feb2de6717758e065268e3cc5953f30452b4306a89b75868",
  gitVersion: "git version 2.54.0 (Apple Git-157)",
  commands: {
    stage: {
      cmd: "git ls-files --stage",
      output:
        "100644 53a51bcbb790266982718d2c33fad67038e9dd75 0\tREADME.md\n100644 c6ab35b0a313fa2896025cf3f63e05811b727038 0\tpaired.txt\n120000 42061c01a1c70097d1e4579f29a5adf40abdec95 0\treadme-link\n100644 909e51c753873085001d585eaf033e9a2b4a8b90 0\tstaged-only.txt\n100755 5c6ea2239367f995732955e1bdd933e897b17a37 0\ttool.sh\n100644 c730a85058b5ae2b0a6d1f91ab5004ce40f8bf3b 0\tunstaged-only.txt\n",
    },
    statusFirst: {
      cmd: "git status --porcelain=v1",
      output: "MM paired.txt\nM  staged-only.txt\n M unstaged-only.txt\n",
    },
    statusRepeated: {
      cmd: "git status --porcelain=v1",
      output: "MM paired.txt\nM  staged-only.txt\n M unstaged-only.txt\n",
    },
    statusAfterPatch: {
      cmd: "git status --porcelain=v1",
      output: " M README.md\nMM paired.txt\nM  staged-only.txt\n M unstaged-only.txt\n",
    },
  },
  patch: {
    path: "README.md",
    before: "tracked baseline\n",
    after: "tracked baseline\nnative-turn-2-git-edit\n",
    input:
      "*** Begin Patch\n*** Update File: /workspace/README.md\n@@\n tracked baseline\n+native-turn-2-git-edit\n*** End Patch\n",
    expectedOutput: "Success. Updated the following files:\nM /workspace/README.md\n",
  },
});
