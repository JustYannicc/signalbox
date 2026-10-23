# Build the pinned source with the managed-pool Codex device-login and
# Claude manual OAuth patches.
# Keep the runtime image static and shell-free because every managed pool has one.
FROM --platform=$BUILDPLATFORM golang:1.26.4-bookworm AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq \
  && rm -rf /var/lib/apt/lists/*

COPY release.json /release.json
COPY cliproxyapi-*.patch apply-carry-patches.sh /tmp/cliproxyapi/
RUN VERSION="$(jq -er '.version' /release.json)" \
  && SOURCE_COMMIT="$(jq -er '.source.commit' /release.json)" \
  && git clone --depth 1 --branch "v${VERSION}" --single-branch \
      https://github.com/router-for-me/CLIProxyAPI.git /src \
  && ACTUAL_COMMIT="$(git -C /src rev-parse HEAD)" \
  && if [ "$ACTUAL_COMMIT" != "$SOURCE_COMMIT" ]; then \
       echo "CLIProxyAPI v${VERSION} resolved to ${ACTUAL_COMMIT}, expected pinned source ${SOURCE_COMMIT}." >&2; \
       exit 1; \
     fi \
  && /tmp/cliproxyapi/apply-carry-patches.sh /src

WORKDIR /src
RUN go mod download

# CI enables focused fake-auth tests for the carried login flows.
# Normal image builds skip tests but still fail if a carry patch stops applying.
ARG CLIPROXYAPI_TEST_CARRIED_FLOWS=0
RUN if [ "$CLIPROXYAPI_TEST_CARRIED_FLOWS" = "1" ]; then \
      test_output=/tmp/cliproxyapi-carried-tests.json; \
      if ! GOMAXPROCS=2 go test -race -p 2 -count=1 -json \
        -run 'TestCodexCallbackRejectsDeviceState|TestStartOAuthV8CodexDeviceFlowDoesNotRaceConfigReload|TestStartOAuthV8CodexDeviceFlowKeepsConfigAcrossProxyUpdate|TestStartOAuthV8CodexDeviceFlowKeepsSessionWhenClientLeavesAfterFlush|TestStartOAuthV8CodexDeviceFlowBoundsPersistence|CodexDevice|ManualClaude|ClaudeManualFlow|TestGenerateAuthURLKeepsTheLocalCallback' \
        ./sdk/auth ./internal/api/handlers/management ./internal/api ./internal/auth/claude \
        > "$test_output"; then \
        cat "$test_output"; \
        exit 1; \
      fi; \
      if ! jq -s -e '[.[] | select(.Action == "pass" and .Test != null) | .Test] as $passed | ["TestStartOAuthV8CodexDeviceFlowDoesNotRaceConfigReload", "TestStartOAuthV8CodexDeviceFlowKeepsConfigAcrossProxyUpdate", "TestStartOAuthV8CodexDeviceFlowKeepsSessionWhenClientLeavesAfterFlush", "TestStartOAuthV8CodexDeviceFlowRejectsCallbacks", "TestStartOAuthV8CodexDeviceFlowBoundsPersistence", "TestCodexCallbackRejectsDeviceState", "TestCodexDeviceLoginReportsCodeBeforePollingAndHonorsCancellation", "TestStartOAuthV8ClaudeManualFlowUsesHostedCallbackWithoutForwarder", "TestManualClaudeGenerateAuthURLUsesHostedCallback", "TestManualClaudeCodeExchangeUsesTheSameHostedRedirect", "TestGenerateAuthURLKeepsTheLocalCallback"] as $expected | ($expected - $passed) == []' "$test_output" > /dev/null; then \
        cat "$test_output"; \
        echo "CLIProxyAPI carried-flow test filter did not pass all expected tests." >&2; \
        exit 1; \
      fi; \
    fi

# Managed-pool diagnostics need to identify both carried upstream changes.
RUN VERSION="$(jq -er '.version' /release.json)" \
  && COMMIT="$(git rev-parse --short HEAD)-signalbox-6715-723" \
  && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -p 2 -buildvcs=false \
      -ldflags="-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT}" \
      -o /cli-proxy-api ./cmd/server/

FROM --platform=linux/amd64 gcr.io/distroless/static-debian12:nonroot
COPY --from=build /cli-proxy-api /cli-proxy-api
# Config and accounts come from the pool's store (OBJECTSTORE_*), spooled under /tmp.
WORKDIR /tmp
EXPOSE 8317
ENTRYPOINT ["/cli-proxy-api"]
