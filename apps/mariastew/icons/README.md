# App icon

`icon.svg` is the source. Everything it produces is written into `../assets` by
`mise run mariastew:app-icons` (needs `brew install librsvg`) and committed
there, so `main.rs` can `include_bytes!` them and no build needs librsvg.

The tile and the mark are separate elements on purpose: the favicon keeps the
tile's rounded corner, and the home screen variants are composed from `#mark`
on a full-bleed background instead, because iOS and Android round those
themselves. `scripts/gen-app-icons.ts` has the rest of the reasoning, and the
app README has the design constraints — chiefly that 16px is the size that
decides all of it.
