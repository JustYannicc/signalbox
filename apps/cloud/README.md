# cloud

This app has no package exports. Its executable entry is defined in
`package.json` or the deployment configuration; implementation lives in `src/`.
Other workspaces use contracts rather than importing app implementation. Follow the
[workspace rules](../../packages/README.md) when adding imports.

[Cloud source modules](src/README.md) have their own root-file entry points.
