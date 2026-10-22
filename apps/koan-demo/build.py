"""Build the demo library from library.json into the directory named by argv[2].

Each source is fetched once and checked against its SHA-256. Every track is
written without the source's tags or pictures and given the manifest's, in full:
each credited artist on its own (ARTISTS, ALBUMARTISTS), the release type, the
label, the composer, and the licence. FLAC is stream-copied, so its audio is the
artist's; AAC, MP3 and Opus are encoded from it. Covers sit beside the tracks.
"""

import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

from mutagen import id3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4, MP4FreeForm
from mutagen.oggopus import OggOpus

EXT = {"flac": "flac", "opus": "opus", "aac": "m4a", "mp3": "mp3"}
CODEC = {
    "flac": ["-c:a", "copy"],
    "opus": ["-c:a", "libopus", "-b:a", "160k"],
    "aac": ["-c:a", "aac", "-b:a", "256k"],
    "mp3": ["-c:a", "libmp3lame", "-q:a", "0"],
}


def fetch(url, sha256, cache):
    """The source at `url`, downloaded once and checked."""
    path = os.path.join(cache, sha256)
    if os.path.exists(path):
        return path
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(path + ".part", "wb") as f:
                shutil.copyfileobj(r, f)
            break
        except OSError:
            if attempt == 4:
                raise
    digest = hashlib.sha256()
    with open(path + ".part", "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    if digest.hexdigest() != sha256:
        raise ValueError(f"{url}: SHA-256 {digest.hexdigest()}, expected {sha256}")
    os.rename(path + ".part", path)
    return path


def joined(names):
    """How a list of credited artists reads: "A", "A & B", "A, B & C"."""
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " & " + names[-1]


def tags_of(album, track):
    """The tags a track is given, by Vorbis comment name; lists are multi-valued."""
    artists = track.get("artists", album["album_artists"])
    licence = track.get("licence", album.get("licence"))
    licence_url = track.get("licence_url", album.get("licence_url"))
    year = track.get("copyright_year", album["date"])
    tags = {
        "TITLE": track["title"],
        "ARTIST": joined(artists),
        "ARTISTS": artists,
        "ALBUM": album["album"],
        "ALBUMARTIST": joined(album["album_artists"]),
        "ALBUMARTISTS": album["album_artists"],
        "DATE": album["date"],
        "GENRE": track.get("genre", album["genre"]),
        "TRACKNUMBER": str(track["track"]),
        "TRACKTOTAL": str(album.get("track_total", len(album["tracks"]))),
        "DISCNUMBER": "1",
        "DISCTOTAL": "1",
        "RELEASETYPE": album["release_type"],
        "COPYRIGHT": f"{year} {joined(artists)}" + (f", licensed under {licence}" if licence else ""),
        "WEBSITE": track.get("source", album["source"]),
    }
    if licence_url:
        tags["LICENSE"] = licence_url
    for key, field in (("LABEL", "label"), ("COMPOSER", "composer")):
        value = track.get(field, album.get(field))
        if value:
            tags[key] = value
    if album.get("compilation"):
        tags["COMPILATION"] = "1"
    return tags


def as_list(value):
    return value if isinstance(value, list) else [value]


def write_vorbis(f, tags):
    for key, value in tags.items():
        f[key] = as_list(value)
    f.save()


MP4_ATOMS = {
    "TITLE": "\xa9nam", "ARTIST": "\xa9ART", "ALBUM": "\xa9alb", "ALBUMARTIST": "aART",
    "DATE": "\xa9day", "GENRE": "\xa9gen", "COMPOSER": "\xa9wrt", "COPYRIGHT": "cprt",
}
MP4_FREEFORM = {
    "ARTISTS": "ARTISTS", "ALBUMARTISTS": "ALBUMARTISTS", "LABEL": "LABEL",
    "RELEASETYPE": "MusicBrainz Album Type", "LICENSE": "LICENSE", "WEBSITE": "WEBSITE",
}


def write_mp4(path, tags):
    f = MP4(path)
    for key, atom in MP4_ATOMS.items():
        if key in tags:
            f[atom] = as_list(tags[key])
    for key, name in MP4_FREEFORM.items():
        if key in tags:
            f[f"----:com.apple.iTunes:{name}"] = [MP4FreeForm(v.encode()) for v in as_list(tags[key])]
    f["trkn"] = [(int(tags["TRACKNUMBER"]), int(tags["TRACKTOTAL"]))]
    f["disk"] = [(1, 1)]
    if tags.get("COMPILATION"):
        f["cpil"] = True
    f.save()


def write_id3(path, tags):
    f = id3.ID3()
    text = {
        "TITLE": id3.TIT2, "ARTIST": id3.TPE1, "ALBUM": id3.TALB, "ALBUMARTIST": id3.TPE2,
        "DATE": id3.TDRC, "GENRE": id3.TCON, "LABEL": id3.TPUB, "COMPOSER": id3.TCOM,
        "COPYRIGHT": id3.TCOP, "COMPILATION": id3.TCMP,
    }
    for key, frame in text.items():
        if key in tags:
            f.add(frame(encoding=3, text=as_list(tags[key])))
    f.add(id3.TRCK(encoding=3, text=f"{tags['TRACKNUMBER']}/{tags['TRACKTOTAL']}"))
    f.add(id3.TPOS(encoding=3, text="1/1"))
    for key, desc in (("ARTISTS", "ARTISTS"), ("ALBUMARTISTS", "ALBUMARTISTS"), ("RELEASETYPE", "MusicBrainz Album Type")):
        f.add(id3.TXXX(encoding=3, desc=desc, text=as_list(tags[key])))
    if "LICENSE" in tags:
        f.add(id3.WCOP(url=tags["LICENSE"]))
    f.add(id3.WOAS(url=tags["WEBSITE"]))
    f.save(path, v2_version=4)


def build(job):
    album, track, source, dest = job
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    encoding = album["encoding"]
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", source, "-map", "0:a", "-map_metadata", "-1", *CODEC[encoding], dest],
        check=True,
    )
    tags = tags_of(album, track)
    if encoding == "flac":
        write_vorbis(FLAC(dest), tags)
    elif encoding == "opus":
        write_vorbis(OggOpus(dest), tags)
    elif encoding == "aac":
        write_mp4(dest, tags)
    else:
        write_id3(dest, tags)
    return os.path.relpath(dest, sys.argv[2])


def main():
    manifest, out = sys.argv[1], sys.argv[2]
    here = os.path.dirname(os.path.abspath(manifest))
    with open(manifest) as f:
        albums = json.load(f)["albums"]
    cache = tempfile.mkdtemp()
    jobs, covers = [], []
    for album in albums:
        folder = os.path.join(out, album["folder"])
        covers.append((album["cover"], os.path.join(folder, album["cover"]["name"])))
        for track in album["tracks"]:
            name = f"{track['track']:02d} {track['title'].replace('/', '-')}.{EXT[album['encoding']]}"
            jobs.append((album, track, os.path.join(folder, name)))
    with concurrent.futures.ThreadPoolExecutor(int(os.environ.get("JOBS", "8"))) as pool:
        # Each source once, however many tracks are made from it.
        wanted = {t["sha256"]: t["url"] for _, t, _ in jobs}
        wanted.update({c["sha256"]: c["url"] for c, _ in covers if "url" in c})
        sources = dict(zip(wanted, pool.map(lambda kv: fetch(kv[1], kv[0], cache), wanted.items())))
        for path in pool.map(build, [(a, t, sources[t["sha256"]], d) for a, t, d in jobs]):
            print(path, flush=True)
    for cover, dest in covers:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(sources[cover["sha256"]] if "url" in cover else os.path.join(here, cover["file"]), dest)
    shutil.rmtree(cache)


if __name__ == "__main__":
    main()
