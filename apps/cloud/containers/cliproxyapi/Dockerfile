# The CLIProxyAPI every managed account pool runs (src/pool/PoolContainer.ts).
# Kept small because every pool has one: CLIProxyAPI's static no-plugin
# release build on distroless, with no shell or package manager at runtime.
# The scheduled release sync updates the shared manifest with the release's
# platform and container assets from checksums.txt.

FROM alpine:3.22 AS fetch
RUN apk add --no-cache jq
COPY release.json /release.json
RUN VERSION="$(jq -er '.version' /release.json)" \
  && ARCHIVE="$(jq -er '.container.name' /release.json)" \
  && SHA256="$(jq -er '.container.sha256' /release.json)" \
  && wget -q -O /cpa.tar.gz \
      "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}/${ARCHIVE}" \
  && echo "${SHA256}  /cpa.tar.gz" | sha256sum -c - \
  && tar -xzf /cpa.tar.gz -C / cli-proxy-api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=fetch /cli-proxy-api /cli-proxy-api
# Config and accounts come from the pool's store (OBJECTSTORE_*), spooled under /tmp.
WORKDIR /tmp
EXPOSE 8317
ENTRYPOINT ["/cli-proxy-api"]
