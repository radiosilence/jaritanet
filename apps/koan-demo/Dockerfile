# The music koan's public demo plays, under /music: the releases library.tsv
# lists, fetched, checked and tagged by build.sh, with their covers, the
# sample playlists and CREDITS.md. koan's chart copies /music into the demo's
# pod with this image's `cp`.
FROM alpine:3.22 AS build
RUN apk add --no-cache curl ffmpeg
WORKDIR /src
COPY library.tsv build.sh ./
RUN sh build.sh /music
COPY covers/monsieur-lowtec.jpg ["/music/Monsieur LowTec/Great LowTec Xperience (2005)/cover.jpg"]
COPY playlists/ /music/Playlists/
COPY CREDITS.md /music/
RUN chmod -R a+rX /music

FROM busybox:1.37
COPY --from=build /music /music
