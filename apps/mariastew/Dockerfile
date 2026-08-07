# Compiled inside the Dockerfile rather than copied in from CI like
# mcp-gateway's static binary: the reusable workflow this repo standardises on
# (blit-workflows/build-publish-container.yml) builds from a Dockerfile
# context and has no way to consume a pre-built artefact, so a copied-in
# binary means a bespoke pipeline instead of the working one — the cost that
# pattern exists to avoid. Each architecture builds on its own native runner,
# so there is no emulation penalty to pay for compiling here.
FROM rust:1.97-alpine AS build

RUN apk add --no-cache musl-dev
WORKDIR /src

# Dependencies first, against a stub main, so editing the source doesn't rebuild
# them.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && \
    cargo build --release --locked && \
    rm -rf src

COPY src ./src
COPY templates ./templates
COPY assets ./assets
# Cargo would otherwise reuse the stub's artefact — same crate, and the only
# newer input is a path it has already built.
RUN touch src/main.rs && cargo build --release --locked

# alpine, not scratch: the pod runs this image twice, service and an aria2c
# sidecar, so the image has to carry aria2c itself, not just the compiled
# binary.
FROM alpine:3.24

# VALIDATED, DO NOT "SIMPLIFY" THIS AWAY:
# reqwest's "rustls" feature (Cargo.toml) pulls in rustls-platform-verifier,
# which reads the system trust store and does NOT fall back to the webpki
# roots compiled into the binary. Neither mariastew's own client (Hydra to
# authenticate, Telegram to notify) nor aria2c carries one of its own, so
# without ca-certificates the TLS client refuses to build at all — this is
# the exact failure mcp-gateway hit on a bare base:
#   Client::new(): reqwest::Error { kind: Builder,
#     source: General("No CA certificates were loaded from the system") }
# — a crash at client construction, not at request time, so there's no
# request log to debug it from. One apk package fixes it for both binaries
# at once because they share the OS trust store.
RUN apk add --no-cache aria2 ca-certificates

COPY --from=build /src/target/release/mariastew /mariastew

EXPOSE 8080
ENV BIND_ADDR=0.0.0.0:8080

# The media tree is owned by uid 1000 throughout and Samba serves it as that
# user, so anything this writes as root would be readable by the shares but
# not manageable by them.
USER 1000:1000

LABEL org.opencontainers.image.title="mariastew"
LABEL org.opencontainers.image.vendor="James Cleveland"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/radiosilence/jaritanet"

ENTRYPOINT ["/mariastew"]
