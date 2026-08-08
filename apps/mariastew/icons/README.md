# App icon

The SVG is the source and every PNG beside it is a build output, written by
`mise run mariastew:icons:png` (needs `brew install librsvg`). They are
committed so a browser that will not take `image/svg+xml`, and every OS that
wants a real bitmap for a home screen, has one without librsvg being installed
wherever the container gets built.

Each size is rendered directly rather than downsampled from 512, so the shapes
land on whole pixels at the small end.

## What the drawings are constrained by

16px is the size that decides an icon — it is the browser tab, and a mark that
survives it survives every size above it. That is what all of these are drawn
against, and it rules out most of what makes a nice illustration:

- Flat filled shapes, not Lucide-style strokes. `templates/icons.html` is a
  line-icon set because those icons sit inline in a sentence at text size; a
  2-unit stroke on a 24 grid is a third of a pixel at 16, which is a grey smear.
- Three or four shapes, one silhouette. Detail below about 4 units on the 64
  grid — a nose, a tooth, a bubble — is texture at 16px, not a feature, and
  nothing is allowed to depend on it reading.
- Two fills carrying the meaning, on a tile dark enough to hold both. A mark
  that needs a light background disappears against a dark tab strip.

## The bake-off

`candidates/` holds ten of them for [#373](https://github.com/radiosilence/jaritanet/issues/373),
drawn around what the name is: aria2 said out loud is "Maria Stew", and what it
does is fetch things off strangers with magnet links. So — pots, magnets,
skulls, and the overlaps.

They are here to be looked at and thrown away. Once one wins it moves up to
`icons/` as the single source, and the directory goes.
