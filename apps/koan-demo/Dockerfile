# The music koan's public demo plays: freely licensed releases listed in
# library.tsv (folder, file, URL, SHA-256), fetched and checked at build, under
# /music. koan's chart copies /music into the demo's pod with this image's `cp`.
# CREDITS.md names each release, its artist and its licence.
FROM alpine:3.22 AS fetch
RUN apk add --no-cache curl
COPY library.tsv /library.tsv
RUN set -eu; tab="$(printf '\t')"; \
    grep -v '^#' /library.tsv | while IFS="$tab" read -r dir file url sha; do \
      mkdir -p "/music/$dir"; \
      curl -fsSL --retry 5 --retry-all-errors -o "/music/$dir/$file" "$url"; \
      echo "$sha  /music/$dir/$file" | sha256sum -c -; \
    done; \
    chmod -R a+rX /music

FROM busybox:1.37
COPY --from=fetch /music /music
COPY CREDITS.md /music/CREDITS.md
