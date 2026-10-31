# The music koan's public demo plays, under /music: the releases library.json
# lists, fetched, checked and tagged by build.py, with their covers, the sample
# playlists and CREDITS.md. The demo mounts it as an image volume.
#
# The music is the same for every architecture, so it is made once, natively
# on the builder, rather than once per platform under emulation.
FROM --platform=$BUILDPLATFORM alpine:3.24 AS build
RUN apk add --no-cache ca-certificates ffmpeg python3 py3-mutagen
WORKDIR /src
COPY library.json build.py ./
COPY covers/ covers/
RUN python3 build.py library.json /music
COPY playlists/ /music/Playlists/
COPY CREDITS.md /music/
RUN chmod -R a+rX /music

FROM busybox:1.38
COPY --from=build /music /music
