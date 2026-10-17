# Cloud modules

Each direct directory here is a module. Its root files are public entry points;
every subfolder is private implementation. Code inside a module can import its
implementation freely. Other modules and the composition files here use only its
root entry points.

```text
capability/
  Service.ts           public entry point
  adapters/            private platform implementation
  tests/               tests and fixtures
```

Tests use entry points and their own fixtures, including tests co-located in
implementation folders. Production code cannot import test folders. Avoid a barrel
that re-exports all implementation; several small entry points are fine.

Clients use contracts and RPC, with platform APIs confined to adapters.
`vp run lint:boundaries` checks these rules and dependency cycles, including type
imports. See [workspace rules](../../../packages/README.md) for severity and the
baseline. Existing leaks get fixed as PRs touch them, without a backend migration
or a change to T3 Code's thread model.
