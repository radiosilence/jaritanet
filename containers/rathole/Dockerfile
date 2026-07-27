# rathole, packaged ourselves.
#
# The upstream image (rapiz1/rathole) was last pushed in October 2023 and is
# amd64-only, so it cannot run on arm64 at all — which blocks moving the home
# side to a Pi, and leaves a three-year-old base on the pod that carries every
# byte between the gateway and home.
#
# No fork needed: upstream publishes a static musl binary for every arch we
# want, so this just fetches the pinned release for the target platform. The
# version tracks the same RATHOLE_VERSION the gateway installs, so both ends of
# the tunnel move together.
FROM alpine:3.22 AS fetch
ARG RATHOLE_VERSION=v0.5.0
# Set by buildx per platform — amd64 | arm64.
ARG TARGETARCH
RUN apk add --no-cache curl unzip && \
    case "$TARGETARCH" in \
      amd64) TRIPLE=x86_64-unknown-linux-musl ;; \
      arm64) TRIPLE=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/rathole.zip \
      "https://github.com/rapiz1/rathole/releases/download/${RATHOLE_VERSION}/rathole-${TRIPLE}.zip" && \
    unzip -j /tmp/rathole.zip rathole -d /out && \
    chmod +x /out/rathole

# Statically linked, so it needs nothing around it. Nothing to patch, nothing to
# scan, and no shell for anything that lands in the pod to use.
FROM scratch
COPY --from=fetch /out/rathole /app/rathole
ENTRYPOINT ["/app/rathole"]
