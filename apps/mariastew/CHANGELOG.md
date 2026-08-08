# Changelog

All notable changes to mariastew are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.20] - 2026-08-08

### Changed

- "Done" is "Clear" and "Delete download" is "Cancel & delete" — both now say what they do to the list, and a completed download reads "downloaded" rather than "ready" ([#354](https://github.com/radiosilence/jaritanet/issues/354))
- Every control that changes something on the server spins and disables itself for its own request, rather than waiting for the next snapshot to show the press landed ([#354](https://github.com/radiosilence/jaritanet/issues/354))
- Clearing holds the response open until aria2 has actually let go, and stops the download with `forceRemove` rather than waiting for the swarm to be told. A removal that does not take answers with a status instead of a silent 204 ([#354](https://github.com/radiosilence/jaritanet/issues/354))
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
