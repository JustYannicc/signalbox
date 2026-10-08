# The CLIProxyAPI every managed account pool runs (src/pool/PoolContainer.ts).
# Kept small because every pool has one: CLIProxyAPI's static no-plugin
# release build on distroless, with no shell or package manager at runtime.
# Bump VERSION and SHA256 together, from the release's checksums.txt, in step
# with ACCOUNT_HUB_VERSION in apps/server/src/accountHub/AccountHubRelease.ts.

FROM alpine:3.22 AS fetch
ARG VERSION=8.0.15
ARG SHA256=e312357315d560a94cb46caa7800f4020f4a20714959dd3ba762a634b4f5fbda
RUN wget -q -O /cpa.tar.gz \
      "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}/CLIProxyAPI_${VERSION}_linux_amd64_no-plugin.tar.gz" \
  && echo "${SHA256}  /cpa.tar.gz" | sha256sum -c - \
  && tar -xzf /cpa.tar.gz -C / cli-proxy-api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=fetch /cli-proxy-api /cli-proxy-api
# Config and accounts come from the pool's store (OBJECTSTORE_*), spooled under /tmp.
WORKDIR /tmp
EXPOSE 8317
ENTRYPOINT ["/cli-proxy-api"]
