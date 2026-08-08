# `mariastew` is compiled by the CI job that calls this build, not here: a
# `cargo build` inside a Dockerfile is one atomic layer, so any movement in
# Cargo.lock recompiles every dependency — 168s of them against 15s of our own
# code. Cargo's cache subdivides by crate, but it only survives between runs
# somewhere Docker isn't, which is the runner. See
# .github/workflows/build-mariastew-container.yml.
#
# So this file no longer builds on its own: it wants a `mariastew` binary for
# the target architecture sitting beside it, which CI unpacks from the artefact
# its compile job uploaded. Local iteration never comes through here — `mise
# run mariastew:dev` builds Dockerfile.dev, which still compiles inline
# because no job feeds it.
#
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

# --chmod because actions/upload-artifact does not preserve modes, so the
# binary arrives in the context without its exec bit.
COPY --chmod=755 mariastew /mariastew

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
