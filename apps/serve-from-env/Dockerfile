# A static musl binary on scratch: the content lives in the environment and
# nothing shells out, so there is no reason to ship a userland for an attacker
# to find.
#
# Compiled by CI's `binary` job rather than here, as `auth` is: a `cargo build`
# inside a Dockerfile is one atomic layer, and an arm64 one would run emulated.
# The context is a directory holding `<arch>/serve-from-env` for each target
# architecture, which CI assembles in `dist/`. Reproduced locally:
#
#   docker buildx build -f apps/serve-from-env/Dockerfile --platform linux/amd64 dist
FROM scratch

# --chmod because actions/upload-artifact does not preserve modes.
ARG TARGETARCH
COPY --chmod=755 ${TARGETARCH}/serve-from-env /serve-from-env

USER 65534:65534
EXPOSE 8080

ENTRYPOINT ["/serve-from-env"]
