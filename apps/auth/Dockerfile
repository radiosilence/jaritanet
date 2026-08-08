# Compiled inside the Dockerfile rather than copied in from CI: the reusable
# workflow this repo standardises on (blit-workflows/build-publish-container.yml)
# builds from a Dockerfile context and cannot consume a pre-built artefact. Each
# architecture builds on its own native runner, so there is no emulation penalty
# for compiling here.
FROM rust:1.97-alpine AS build

RUN apk add --no-cache musl-dev ca-certificates
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

# scratch, unlike mariastew's alpine: this pod runs one static binary and shells
# out to nothing, so there is no userland here for anything to find.
FROM scratch

# VALIDATED, DO NOT "SIMPLIFY" THIS AWAY:
# reqwest's "rustls" feature pulls in rustls-platform-verifier, which reads the
# system trust store and does NOT fall back to the webpki roots compiled into
# the binary. Every login calls GitHub, and without a CA bundle on disk the TLS
# client fails at construction rather than at request time — so there is no
# request log to debug it from. Taken from the build stage so there is no second
# base image involved.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

COPY --from=build /src/target/release/auth /auth

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
