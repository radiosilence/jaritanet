# `auth` is compiled by CI's `binary` job, not here: a `cargo build` inside a
# Dockerfile is one atomic layer, so any movement in Cargo.lock recompiles every
# dependency. Cargo's cache subdivides by crate, but it only survives between
# runs somewhere Docker isn't, which is the runner. See .github/workflows/ci-cd.yml.
#
# So this file does not build on its own: its context is a directory holding
# `<arch>/auth` for each target architecture, which CI assembles in `dist/` from
# the binaries that job uploaded. Reproduced locally:
#
#   docker buildx build -f apps/auth/Dockerfile --platform linux/amd64 dist
#
# scratch, unlike mariastew's alpine: this pod runs one static binary and shells
# out to nothing, so there is no userland here for anything to find.
FROM scratch

# No CA bundle: the binary carries the only roots it trusts (roots.pem, via
# `tls_certs_only`), so the image has no trust store for a base to get wrong.

# --chmod because actions/upload-artifact does not preserve modes, so the
# binary arrives in the context without its exec bit.
ARG TARGETARCH
COPY --chmod=755 ${TARGETARCH}/auth /auth

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
