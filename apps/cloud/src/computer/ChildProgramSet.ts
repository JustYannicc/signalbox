export const CHILD_COREUTILS_COMMANDS = Object.freeze([
  "echo",
  "printf",
  "ls",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "pwd",
  "head",
  "tail",
  "wc",
  "uniq",
] as const);

export type ChildCoreutilsCommand = (typeof CHILD_COREUTILS_COMMANDS)[number];

export const CHILD_BUSYBOX_APPLETS = Object.freeze(["cat", "grep", "touch"] as const);

export const CHILD_PRODUCT_BUSYBOX_APPLETS = Object.freeze(["env", "id", "sort"] as const);

export const CHILD_PROGRAM_PATHS = Object.freeze({
  bash: "/bin/bash",
  sh: "/bin/sh",
  cat: "/bin/cat",
  sed: "/bin/sed",
  grep: "/bin/grep",
  touch: "/bin/touch",
  rg: "/bin/rg",
  echo: "/bin/echo",
  printf: "/bin/printf",
  ls: "/bin/ls",
  mkdir: "/bin/mkdir",
  rm: "/bin/rm",
  cp: "/bin/cp",
  mv: "/bin/mv",
  pwd: "/bin/pwd",
  head: "/bin/head",
  tail: "/bin/tail",
  wc: "/bin/wc",
  uniq: "/bin/uniq",
  env: "/bin/env",
  id: "/bin/id",
  sort: "/bin/sort",
  git: "/usr/bin/git",
  jq: "/usr/bin/jq",
});
