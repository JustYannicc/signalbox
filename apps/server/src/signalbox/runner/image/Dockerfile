# syntax=docker/dockerfile:1
# The Runner image: what every thread's VM runs. Node, git, the Runner, exact
# `claude` and `codex` versions, and a pinned headless browser. No Signalbox
# server and no provider keys: the harnesses reach their models through the
# ModelGateway.
#
# The build context is the bundled Runner (`vp run runner:bundle` in
# apps/server writes dist/runner/main.mjs). `.github/workflows/runner-image.yml`
# publishes it as ghcr.io/justyannicc/signalbox-runner for nightly and stable.

# The headless browser agents check their own work with (#402): the Chrome for
# Testing headless shell `PreviewBrowser.ts` pins, at the same version and
# checksums (RunnerImage.test.ts keeps them equal). Each architecture fetches
# only its own archive.
ARG CHROME_HEADLESS_SHELL_VERSION=154.0.8037.92
FROM scratch AS chrome-amd64
ARG CHROME_HEADLESS_SHELL_VERSION
ADD --checksum=sha256:636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9 \
  https://storage.googleapis.com/chrome-for-testing-public/${CHROME_HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip /chrome.zip
FROM scratch AS chrome-arm64
ARG CHROME_HEADLESS_SHELL_VERSION
ADD --checksum=sha256:0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6 \
  https://storage.googleapis.com/chrome-for-testing-public/${CHROME_HEADLESS_SHELL_VERSION}/linux-arm64/chrome-headless-shell-linux-arm64.zip /chrome.zip
ARG TARGETARCH
FROM chrome-${TARGETARCH} AS chrome-archive
FROM node:24-bookworm-slim AS chrome
COPY --from=chrome-archive /chrome.zip /tmp/chrome.zip
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
  && unzip -q /tmp/chrome.zip -d /opt \
  && mv /opt/chrome-headless-shell-linux* /opt/chrome-headless-shell

FROM node:24-bookworm-slim

# The browser's libraries (`DEBIAN_PACKAGES` in PreviewBrowserHost.ts) and
# fonts for its screenshots.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libnss3 libglib2.0-0 libatk1.0-0 libatk-bridge2.0-0 \
    libatspi2.0-0 libdbus-1-3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxkbcommon0 libgbm1 libasound2 libexpat1 fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
COPY --from=chrome /opt/chrome-headless-shell /opt/chrome-headless-shell
# The machine is the thread's own sandbox and its containers can't create the
# user namespace Chrome's sandbox needs; the browser carries no logins.
ENV SIGNALBOX_BROWSER_EXECUTABLE=/opt/chrome-headless-shell/chrome-headless-shell \
  T3CODE_SERVER_BROWSER_SANDBOX=0

# rclone and fuse3 mount every drive the user can read at /drives (RunnerDrivesMount.ts).
# Python, make, a C/C++ compiler and pkg-config are what node-gyp and most
# native dependencies need to build on install. curl, wget, jq, unzip and
# git-lfs are what agents and `curl … | sh` installers reach for first (#595).
# Anything a project needs beyond that comes from its environment (#123).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fuse3 git lsof openssh-client procps rclone ripgrep \
    python3 make g++ pkg-config curl wget jq unzip git-lfs \
  && rm -rf /var/lib/apt/lists/* \
  && git lfs install --system \
  && install -d -o node -g node /drives

# Bump these to move every new machine to another harness release. Declared
# here so a bump leaves the layers above alone.
ARG CLAUDE_CODE_VERSION=2.1.292
ARG CODEX_VERSION=0.160.1
# npm 11 skips install scripts unless allowed; Claude Code's links its native binary.
RUN npm install --global --no-fund --no-audit --allow-scripts=@anthropic-ai/claude-code \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && claude --version && codex --version

# `pnpm` and `yarn` at the version each project's `packageManager` names,
# fetched once into the machine's caches (`COREPACK_HOME`, RunnerCaches.ts).
RUN corepack enable pnpm yarn

# Bun, for projects with a `bun.lock` (RunnerDependencies.ts). Corepack doesn't
# manage it; its npm package fetches the native binary on install.
ARG BUN_VERSION=1.4.3
RUN npm install --global --no-fund --no-audit --allow-scripts=bun "bun@${BUN_VERSION}" \
  && npm cache clean --force \
  && bun --version

# What the Runner loads from disk beside itself, at the versions apps/server
# pins: Playwright, which drives the browser; rrweb's recorder, which the
# browser's tabs run so people can watch them (`RunnerBrowserRecorder.ts`);
# 1Password's SDK, which reads a folder's secrets (RunnerOnePassword.ts) and
# loads its WebAssembly core from beside itself; and oxc's native parser and
# transformer, which compile the automations agents save; and node-pty, which
# runs thread terminals. One install: a second `--no-save` install into the
# same prefix prunes the first one's packages. Load checks and a PTY smoke
# test below catch missing runtime dependencies.
ARG PLAYWRIGHT_CORE_VERSION=1.60.0
ARG RRWEB_RECORD_VERSION=2.1.7
ARG ONEPASSWORD_SDK_VERSION=0.5.0
ARG OXC_VERSION=0.148.0
ARG NODE_PTY_VERSION=1.2.0-beta.15
RUN install -d /opt/signalbox \
  && npm install --prefix /opt/signalbox --no-fund --no-audit --no-save \
    --allow-scripts=node-pty \
    "playwright-core@${PLAYWRIGHT_CORE_VERSION}" "@rrweb/record@${RRWEB_RECORD_VERSION}" \
    "@1password/sdk@${ONEPASSWORD_SDK_VERSION}" "oxc-parser@${OXC_VERSION}" "oxc-transform@${OXC_VERSION}" \
    "node-pty@${NODE_PTY_VERSION}" \
  && npm cache clean --force \
  && cd /opt/signalbox && node -e 'require("playwright-core"); require("@rrweb/record"); require("@1password/sdk"); require("oxc-parser"); require("oxc-transform")'

# Every machine class keeps threads' workspaces at the same path (`MACHINE_HOME`
# in RunnerProtocol.ts, #620); a boat VM mounts its disk over it.
RUN install -d -o node -g node /home/user/signalbox

COPY main.mjs /opt/signalbox/runner.mjs

# The commit the Runner was built from, for each turn's diagnostics. Declared
# after the slow layers so a new commit leaves their cache alone.
ARG SIGNALBOX_RUNNER_REVISION
ENV SIGNALBOX_RUNNER_REVISION=${SIGNALBOX_RUNNER_REVISION}

# Claude Code refuses to skip permission prompts as root. `node` is uid 1000,
# the same as boat's `user`, so files on the machine's disk keep one owner.
USER node

RUN cd /opt/signalbox && node -e '\
  const pty = require("node-pty").spawn("/bin/sh", ["-c", "printf terminal-image-smoke"], { cols: 80, rows: 24 }); \
  let output = ""; \
  const timer = setTimeout(() => { pty.kill(); process.exit(1); }, 8000); \
  pty.onData(data => { output += data; }); \
  pty.onExit(({ exitCode }) => { clearTimeout(timer); process.exit(exitCode === 0 && output.includes("terminal-image-smoke") ? 0 : 1); });'

ENTRYPOINT ["node", "/opt/signalbox/runner.mjs"]
CMD ["machine"]
