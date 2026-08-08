# `auth` is compiled by the CI job that calls this build, not here: a
# `cargo build` inside a Dockerfile is one atomic layer, so any movement in
# Cargo.lock recompiles every dependency. Cargo's cache subdivides by crate,
# but it only survives between runs somewhere Docker isn't, which is the
# runner. See .github/workflows/build-auth-container.yml.
#
# So this file no longer builds on its own: it wants an `auth` binary for the
# target architecture sitting beside it, which CI unpacks from the artefact its
# compile job uploaded.
#
# scratch, unlike mariastew's alpine: this pod runs one static binary and shells
# out to nothing, so there is no userland here for anything to find.
FROM scratch

# VALIDATED, DO NOT "SIMPLIFY" THIS AWAY:
# reqwest's "rustls" feature pulls in rustls-platform-verifier, which reads the
# system trust store and does NOT fall back to the webpki roots compiled into
# the binary. Every login calls GitHub, and without a CA bundle on disk the TLS
# client fails at construction rather than at request time — so there is no
# request log to debug it from. Alpine's base image already carries the bundle
# (`ca-certificates-bundle`), so this is a copy out of it rather than a stage
# that installs anything — and a base that stopped shipping it fails the build
# rather than the first login.
COPY --from=alpine:3.24 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# --chmod because actions/upload-artifact does not preserve modes, so the
# binary arrives in the context without its exec bit.
COPY --chmod=755 auth /auth

EXPOSE 8080
ENV BIND_ADDR=0.0.0.0:8080

# scratch carries no /etc/passwd, so this has to be a raw numeric uid. Nothing
# is written to disk, so there is no ownership for it to need.
USER 10001:10001

LABEL org.opencontainers.image.title="auth"
LABEL org.opencontainers.image.vendor="James Cleveland"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/radiosilence/jaritanet"

ENTRYPOINT ["/auth"]
