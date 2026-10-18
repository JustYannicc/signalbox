This interpreter source is vendored from
`https://github.com/AshishKumar4/Nimbus` at commit
`e9f019ab4e40cb6037aff7e1a0eaf20842578ed3`.

The vendored core source closure is `packages/core/src/interpreter/*.ts`,
`packages/core/src/_shared/{primordials,runtime-function-source,importer-url}.ts`,
and `packages/core/src/runtime/{binding-pattern,esm-interop,javascript-ast,js-repl-names}.ts`.
The Acorn primordial rewrite in
`worker/scripts/acorn-primordials.mjs` comes from
`packages/worker/scripts/acorn-primordials.mjs` at the same commit. The
corresponding MIT license is in `../LICENSE`.

The generated-function builder also includes the pinned `_shared/commonjs-cell.ts`.
It selects `runtimeFunctionModule`, its `REALM` and its AST helper declarations
before bundling. Those declaration bodies are unchanged; unrelated registry
templates, filesystem/runtime support and node:crypto are not bundled.

The Acorn transform imports the local vendored binding-pattern helper. Its other source bytes are unchanged.

The upstream source keeps its own compiler assumptions. The typed adapter contract
is maintained separately; the prepared-module tests and workerd proof verify it
against this pin when either changes.
