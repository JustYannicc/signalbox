# Node 24.18 glob sources and generated wrappers

`internal/fs/glob.js` is copied byte for byte from Node.js 24.18.0, commit
`20da4aeadabc5b0a01e3fcf520f91df8285c68a2`:

- SHA-256: `b3b3ebcf41f691438f8d91555bbabb9cd22d04ed434448daa11e90198c7d732e`
- Source: <https://github.com/nodejs/node/blob/20da4aeadabc5b0a01e3fcf520f91df8285c68a2/lib/internal/fs/glob.js>
- Generated wrapper: `generated/glob-core.ts`
- Generated SHA-256: `3455b4b6c8c7d9af969191c8985ccde0e207abdca3d8e5dbaab9a20fe3bf969f`

`internal/deps/minimatch/index.js` is Node's bundled minimatch 10.2.5 from the
same Node commit:

- SHA-256: `23f1e425aa0813670574fe2c0241f591ef5463aacf2a23e3284654a49245fd4c`
- Source: `process.binding('natives')['internal/deps/minimatch/index']` in Node 24.18.0
- Included packages: `balanced-match` 4.0.2 and `brace-expansion` 5.0.6
- Generated wrapper: `generated/glob-matcher.ts`
- Generated SHA-256: `ec37102fc78152239c9173f2fffe232ab4e5136f567f948b0d760a9eb1a06f1b`

`apps/cloud/src/isolate/node/fs/generate-glob-wrappers.mjs` verifies both source
hashes and generated wrapper hashes. Run it from the repository root to
regenerate, or pass `--check` to compare the checked-in outputs byte for byte.
The raw vendor files remain byte-for-byte Node sources. The generated wrappers
apply only these textual adaptations: remove the leading strict-mode directive,
replace `process.platform` with the injected `nodeProcess.platform`, and route
the bundled minimatch's `console.error` debug hook to a no-op. The glob core
constructs minimatch with its default `debug: false` and exposes no debug option,
so that hook cannot run through this API. The wrappers place source in static
dependency-injected factories; the generated modules are ordinary TypeScript
and do not evaluate strings or compile code at runtime. Signalbox owns the typed
contracts in `../../glob-contract.ts`, generator, and filesystem dependency map
in `../../glob.ts`.

Node.js licensing is in `LICENSE.node`. Minimatch uses the Blue Oak Model
License in `LICENSE.minimatch`; its bundled dependencies have MIT notices in
`LICENSE.balanced-match` and `LICENSE.brace-expansion`.
