# The Runner image: what every thread's VM runs. Node, git, the Runner, and
# exact `claude` and `codex` versions. No Signalbox server and no provider
# keys: the harnesses reach their models through the ModelGateway.
#
# The build context is the bundled Runner (`vp run runner:bundle` in
# apps/server writes dist/runner/main.mjs). `.github/workflows/runner-image.yml`
# publishes it as ghcr.io/justyannicc/signalbox-runner for nightly and stable.
FROM node:24-bookworm-slim

# Bump these to move every new machine to another harness release.
ARG CLAUDE_CODE_VERSION=2.1.292
ARG CODEX_VERSION=0.160.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git lsof openssh-client procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

# npm 11 skips install scripts unless allowed; Claude Code's links its native binary.
RUN npm install --global --no-fund --no-audit --allow-scripts=@anthropic-ai/claude-code \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && claude --version && codex --version

COPY main.mjs /opt/signalbox/runner.mjs

# Claude Code refuses to skip permission prompts as root. `node` is uid 1000,
# the same as boat's `user`, so files on the machine's disk keep one owner.
USER node

ENTRYPOINT ["node", "/opt/signalbox/runner.mjs"]
CMD ["machine"]
