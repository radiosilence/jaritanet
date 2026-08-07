# Static musl build so the runtime image can be scratch: the content lives in
# the environment and nothing shells out, so there is no reason to ship a
# userland for an attacker to find.
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
# Cargo would otherwise reuse the stub's artefact — same crate, and the only
# newer input is a path it has already built.
RUN touch src/main.rs && cargo build --release --locked

FROM scratch

COPY --from=build /src/target/release/serve-from-env /serve-from-env

USER 65534:65534
EXPOSE 8080

ENTRYPOINT ["/serve-from-env"]
