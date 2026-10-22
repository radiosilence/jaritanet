#!/bin/sh
# Fetches what library.tsv lists into the directory named by $1, checking each
# file against its SHA-256. Tracks are written with the manifest's tags in
# place of their own, and without embedded pictures: FLAC stream-copied, so
# its audio is untouched, everything else encoded from it. Covers sit beside
# the tracks as files.
set -eu
out=$1
manifest=${2:-library.tsv}
tab=$(printf '\t')
src=$(mktemp)
grep -v '^#' "$manifest" | while IFS="$tab" read -r url sha path enc artist album_artist album year genre track title; do
  curl -fsSL --retry 5 --retry-all-errors -o "$src" "$url"
  echo "$sha  $src" | sha256sum -c - >/dev/null
  dest="$out/$path"
  mkdir -p "$(dirname "$dest")"
  case $enc in
    file) cp "$src" "$dest"; continue ;;
    flac) codec="-c:a copy" ;;
    opus) codec="-c:a libopus -b:a 160k" ;;
    aac) codec="-c:a aac -b:a 256k" ;;
    mp3) codec="-c:a libmp3lame -q:a 0" ;;
    *) echo "unknown encoding $enc for $path" >&2; exit 1 ;;
  esac
  # $codec is split into its options on purpose.
  # shellcheck disable=SC2086
  ffmpeg -nostdin -v error -i "$src" -map 0:a -map_metadata -1 $codec \
    -metadata artist="$artist" -metadata album_artist="$album_artist" \
    -metadata album="$album" -metadata date="$year" -metadata genre="$genre" \
    -metadata track="$track" -metadata title="$title" "$dest"
  echo "$path"
done
rm -f "$src"
