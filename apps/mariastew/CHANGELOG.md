# Changelog

All notable changes to mariastew are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.29] - 2026-08-15

### Fixed

- A stream that dies while the page is open comes back on its own. #386 covered the case with a trigger — the page went away and returned — and an ordinary deploy has none: the pod is replaced rather than drained, every open stream ends, and Datastar reads a finished 200 body as the request being over, so a laptop tab left in front of you showed a frozen list until it was reloaded ([#390](https://github.com/radiosilence/jaritanet/issues/390))

### Added

- The stream sends a `datastar-heartbeat` frame every five seconds when it has nothing else to say, and the page reconnects when three of them fail to arrive (`ms.streamLost`). Silence had to be given a meaning first: the stream sends the rows whose hash moved, so a queue with nothing running is silent because there is nothing to report, and a client cannot tell that apart from a socket that stopped carrying bytes without erroring. Datastar's own view of whether the request is live is the one thing this cannot consult — in that case it is wrong, and there is nothing else to ask ([#390](https://github.com/radiosilence/jaritanet/issues/390))

### Changed

- The heartbeat replaces axum's keep-alive. Both stop a proxy timing out an idle connection; only one of them reaches the page, and two mechanisms firing at different rates is one more thing to hold in mind than there needs to be ([#390](https://github.com/radiosilence/jaritanet/issues/390))

## [0.1.28] - 2026-08-09

### Fixed

- Returning to the page reconnects the download stream, so a phone coming back from the app switcher shows live data rather than whatever it last painted. Datastar reopens its own connection on `visibilitychange`, but only while it still considers the request live — a 200 body that simply ends is the request being over, and it removes that listener on the way out, so a stream iOS killed under a suspended page never came back and the page had to be reloaded ([#386](https://github.com/radiosilence/jaritanet/issues/386))
- `Dockerfile.dev` copies `build.rs`, so `docker compose` builds again. It has not since the browser script gained a build script to name its hashed filename (0.1.22), which left local development to a compile error about `APP_JS_FILENAME` ([#386](https://github.com/radiosilence/jaritanet/issues/386))

## [0.1.27] - 2026-08-08

### Added

- An app icon, and the set around it: a favicon (SVG, plus a 16/32/48 `.ico` for anything that will not take one), an apple-touch icon, and a web manifest carrying 192 and 512 at each of `any` and `maskable`, so the tab is no longer the browser's blank page glyph and the home screen no longer a screenshot. Two of each size rather than one declared `any maskable`, because only what is definitely going to be masked can afford to be full-bleed — everywhere else that is a bare square, and everywhere else is where a person actually looks at it. It is a horseshoe magnet holding the stew between its poles — aria2 said out loud is "Maria Stew", and what it does is fetch things off strangers with magnet links. Rendered from one SVG by `mise run mariastew:app-icons` and committed, so no build learns about librsvg ([#373](https://github.com/radiosilence/jaritanet/issues/373))
- A `mariastew` daisyUI theme, which is the icon read out loud: amber is the stew, steel is the magnet, red is its poles, so `btn-primary`, a download bar and a failed download are the three colours in the drawing. daisyUI's own themes are switched off, so the stylesheet carries only the palette it renders ([#373](https://github.com/radiosilence/jaritanet/issues/373))
- The icon's silhouette as a very faint fixed watermark behind the page. The rows on top of it are opaque, so what it is really for is everything that is not a full list — the empty state, the sign-in page, the space under the last row ([#373](https://github.com/radiosilence/jaritanet/issues/373))

### Changed

- A download's state is plain text while it is still moving, rather than each one getting an outlined pill of its own. That spent the loudest shape in the row on "downloading", which the progress bar directly underneath was already saying better; the filled green badge a finished download gets now has the glance to itself, which is what it was introduced for ([#373](https://github.com/radiosilence/jaritanet/issues/373))
- Flat surfaces and smaller radii throughout — daisyUI 5's gradient overlay and surface texture are off, and nothing is a pill. The header carries a border instead of a drop shadow, which on a dark surface was drawing a separation the eye could not see ([#373](https://github.com/radiosilence/jaritanet/issues/373))

## [0.1.26] - 2026-08-08

### Fixed

- A magnet no longer announces itself as downloaded before it starts downloading. The metadata pass reaches aria2's `Complete` when the *torrent file* arrives, and every reading taken off its byte counters was answering about the wrong download: the row turned green and said "downloaded" beside the torrent's name, filled its bar, showed "0s left", and the completion watch sent Telegram a finished message and swept a directory nothing had been written to. A metadata pass now measures nothing (`Download::display_totals`), so the bar is indeterminate, the size and ETA are absent, and the state stays *finding peers* until the real download exists ([#372](https://github.com/radiosilence/jaritanet/issues/372))
- No ETA before the size is known. A resolving magnet moves bytes at a real rate with no total to spend them against, which divided out to "0s left" on a torrent that had not started ([#372](https://github.com/radiosilence/jaritanet/issues/372))

## [0.1.25] - 2026-08-08

### Removed

- The "Added" toast, which never went away. `data-on-signal-patch` is one of Datastar's value-returning attributes, so it wraps the last `;`-separated chunk of the expression in `return (…)` — `{ $addStatus = ''; $addMessage = '' }` compiles to `return ($addMessage = '' })`, a syntax error, so the handler that cleared the signal never existed. It is not replaced: the metadata row is on screen from the moment an add is accepted (0.1.24), so the banner promising one "shortly" was covering the row that already proved it ([#350](https://github.com/radiosilence/jaritanet/issues/350))

### Fixed

- Closing the add dialog clears `$addStatus` whatever it held. A success was deliberately left set for the toast to keep reading, which made the toast the only thing that ever cleared it — and the dialog closes itself on a success, so an `ok` outliving one attempt shuts the next dialog as soon as any signal moves ([#350](https://github.com/radiosilence/jaritanet/issues/350))

## [0.1.24] - 2026-08-08

### Fixed

- An add interrupted by a restart is picked up again. 0.1.23 claimed this and did not do it: `--bt-load-saved-metadata` resolves a restored magnet off the disk before aria2 answers a single RPC, so it comes back named after its file rather than `[METADATA]…` and the rule that looked for one matched nothing. The two fixes cancelled each other out ([#362](https://github.com/radiosilence/jaritanet/issues/362))
- An unfinished add is now recognised by what aria2 holds — paused, with no `select-file` — and reconciled continuously rather than once at startup, so a magnet that resolves long after boot is picked up too. A download somebody paused on purpose already carries a selection, and is left alone ([#362](https://github.com/radiosilence/jaritanet/issues/362))
- An adopted add is narrowed in place when its metadata pass is already over, rather than waiting ten minutes for a `followedBy` that will never appear while the download runs unfiltered ([#362](https://github.com/radiosilence/jaritanet/issues/362))

### Changed

- aria2 creates the followed download stopped (`--pause-metadata`), so the filter's selection lands before any content is fetched. The add no longer pauses it — that raced with aria2's own stop, fetched the whole torrent meanwhile, and stranded the download outright if the process died in the window ([#362](https://github.com/radiosilence/jaritanet/issues/362))

## [0.1.23] - 2026-08-08

### Fixed

- A restored download resumes from the torrent on disk rather than asking the swarm for metadata it already has, so a deploy no longer leaves rows on "finding peers" over data that is already complete ([#359](https://github.com/radiosilence/jaritanet/issues/359))
- An add interrupted by a restart is picked up and finished on startup. It came back paused — that is how aria2 serialises one — with nothing left to start it or to narrow it to the files worth keeping ([#359](https://github.com/radiosilence/jaritanet/issues/359))
- An add no longer loses the race with its own pause. aria2 refuses to unpause a group until it has finished stopping, and a single attempt left the download stopped for good ([#359](https://github.com/radiosilence/jaritanet/issues/359))
- A restored torrent being re-hashed says "checking files" rather than "downloaded". aria2 counts every piece as complete before it starts checking them, so the state that answered first was the wrong one for the longest wait a deploy has ([#359](https://github.com/radiosilence/jaritanet/issues/359))
- The bar and the bytes beside it follow the hash check while one runs, rather than sitting at whatever the download reached ([#359](https://github.com/radiosilence/jaritanet/issues/359))

## [0.1.22] - 2026-08-08

### Added

- `web/app.ts` is now typechecked and bundled with rolldown into a content-hashed `assets/app-<hash>.js`, so a deploy's new script can no longer be served from a browser cache still holding the old one ([#340](https://github.com/radiosilence/jaritanet/issues/340))
- `mise run mariastew:icons` adds a macro to `templates/icons.html` for any `icons::<name>` a template calls that isn't defined yet, sourced from the `lucide-static` package ([#357](https://github.com/radiosilence/jaritanet/issues/357))

## [0.1.21] - 2026-08-08

### Changed

- Ask for the clipboard from a Paste button beside the field, not on every open. Safari's Paste bubble cannot be suppressed, only anchored to the touch that asks for it ([#353](https://github.com/radiosilence/jaritanet/issues/353), [#356](https://github.com/radiosilence/jaritanet/pull/356))

### Fixed

- Make the add sheet usable on iOS: full width, above the keyboard, sized to its content, and no scroll on a page that fits ([#353](https://github.com/radiosilence/jaritanet/issues/353), [#356](https://github.com/radiosilence/jaritanet/pull/356))
- Opening the sheet no longer opens the keyboard with it ([#353](https://github.com/radiosilence/jaritanet/issues/353), [#356](https://github.com/radiosilence/jaritanet/pull/356))
- Stop the "Added" banner flashing up on every page load ([#353](https://github.com/radiosilence/jaritanet/issues/353), [#356](https://github.com/radiosilence/jaritanet/pull/356))
- Create a folder without pasting a magnet first — the button was validating the add form it happens to sit inside ([#353](https://github.com/radiosilence/jaritanet/issues/353), [#356](https://github.com/radiosilence/jaritanet/pull/356))

## [0.1.20] - 2026-08-08

### Changed

- "Done" is "Clear" and "Delete download" is "Cancel & delete" — both now say what they do to the list, and a completed download reads "downloaded" rather than "ready" ([#354](https://github.com/radiosilence/jaritanet/issues/354))
- Every control that changes something on the server spins and disables itself for its own request, rather than waiting for the next snapshot to show the press landed ([#354](https://github.com/radiosilence/jaritanet/issues/354))
- Clearing holds the response open until aria2 has actually let go, and stops the download with `forceRemove` rather than waiting for the swarm to be told. A removal that does not take answers with a status instead of a silent 204 ([#354](https://github.com/radiosilence/jaritanet/issues/354))
- Use magnet icon for add button
- Every mutation is now bounded: 10s on any aria2 call, 10s on `mkdir`, and one second of retries on a removal ([#354](https://github.com/radiosilence/jaritanet/issues/354))

## [0.1.19] - 2026-08-08

### Added

- Show the running version under the list ([#341](https://github.com/radiosilence/jaritanet/issues/341), [#344](https://github.com/radiosilence/jaritanet/pull/344))

## [0.1.18] - 2026-08-08

### Added

- Say something when there is nothing in the list ([#328](https://github.com/radiosilence/jaritanet/issues/328), [#333](https://github.com/radiosilence/jaritanet/pull/333))

### Fixed

- Skeleton for the picker's wait, not the last folder dimmed ([#294](https://github.com/radiosilence/jaritanet/issues/294), [#331](https://github.com/radiosilence/jaritanet/pull/331))

## [0.1.17] - 2026-08-08

### Performance

- Compile mariastew and auth on the runner, not in docker build ([#289](https://github.com/radiosilence/jaritanet/issues/289), [#327](https://github.com/radiosilence/jaritanet/pull/327))

## [0.1.16] - 2026-08-08

### Added

- Read the clipboard when the add sheet opens ([#300](https://github.com/radiosilence/jaritanet/issues/300), [#324](https://github.com/radiosilence/jaritanet/pull/324))

## [0.1.15] - 2026-08-08

### Fixed

- A session for aria2, so a deploy stops erasing the queue ([#288](https://github.com/radiosilence/jaritanet/issues/288), [#329](https://github.com/radiosilence/jaritanet/pull/329))
- One poll for the whole process, and send rows not the list ([#317](https://github.com/radiosilence/jaritanet/issues/317), [#323](https://github.com/radiosilence/jaritanet/pull/323))

## [0.1.14] - 2026-08-08

### Added

- Draw the icons with Lucide, not unicode ([#296](https://github.com/radiosilence/jaritanet/issues/296), [#302](https://github.com/radiosilence/jaritanet/pull/302))

## [0.1.13] - 2026-08-08

### Fixed

- A Done button that actually clears the download ([#316](https://github.com/radiosilence/jaritanet/issues/316), [#321](https://github.com/radiosilence/jaritanet/pull/321))

## [0.1.12] - 2026-08-08

### Fixed

- Clock times in the log, and stop the state flapping ([#298](https://github.com/radiosilence/jaritanet/issues/298), [#320](https://github.com/radiosilence/jaritanet/pull/320))

## [0.1.11] - 2026-08-08

### Fixed

- Sweep the tree on completion, not aria2's file list ([#315](https://github.com/radiosilence/jaritanet/issues/315), [#319](https://github.com/radiosilence/jaritanet/pull/319))

## [0.1.10] - 2026-08-08

### Added

- Rate and time left on the collapsed row ([#308](https://github.com/radiosilence/jaritanet/issues/308), [#318](https://github.com/radiosilence/jaritanet/pull/318))

## [0.1.9] - 2026-08-08

### Added

- Say what aria2 is actually doing ([#298](https://github.com/radiosilence/jaritanet/issues/298), [#307](https://github.com/radiosilence/jaritanet/pull/307))

## [0.1.8] - 2026-08-08

### Fixed

- Show the add, and let a destination be undone ([#292](https://github.com/radiosilence/jaritanet/issues/292))

## [0.1.7] - 2026-08-08

### Fixed

- A picker that says it is working, and a reachable aria2 ([#287](https://github.com/radiosilence/jaritanet/issues/287))

## [0.1.6] - 2026-08-08

### Added

- The add flow tells you what happened ([#286](https://github.com/radiosilence/jaritanet/issues/286))

## [0.1.5] - 2026-08-08

### Fixed

- bt-metadata-only stops followedBy from ever appearing — drop it ([#284](https://github.com/radiosilence/jaritanet/issues/284))

## [0.1.4] - 2026-08-08

### Fixed

- Recognise tracker-attribution spam in the filter
- A selective torrent is finished when its selected files are, not when total_length is ([#282](https://github.com/radiosilence/jaritanet/issues/282))
- Select the right files, and stop lying about being done ([#281](https://github.com/radiosilence/jaritanet/issues/281))

## [0.1.3] - 2026-08-08

### Added

- Docker compose seeds its own fixtures on `up`

### Fixed

- Wrap long directory names instead of clipping them

## [0.1.2] - 2026-08-08

### Added

- Seed dev fixtures shaped like the real library
- Docker compose for local dev

### Fixed

- Downloads actually download, and the UI works on a phone

## [0.1.1] - 2026-08-08

### Fixed

- Use colon syntax for data-on so Datastar binds it

## [0.1.0] - 2026-08-07

### Added

- Initial release: paste a magnet, and later just watch the thing ([#254](https://github.com/radiosilence/jaritanet/issues/254), [#268](https://github.com/radiosilence/jaritanet/pull/268))
