#!/usr/bin/env -S node --experimental-strip-types
/**
 * A fake aria2 JSON-RPC endpoint that serves one download per `Health`.
 *
 * The download list is the part of this UI that cannot be looked at on
 * demand. A stall, a dead magnet, an unconnectable swarm and a disk error are
 * exactly the states worth designing against, and every one of them is
 * something a real swarm hands over on its own schedule or not at all — so
 * the states that most need looking at are the ones least available while
 * looking. This serves all of them at once, immediately.
 *
 * mariastew reaches aria2 over JSON-RPC and nothing else (`src/aria2.rs`), so
 * answering `tellActive`/`tellWaiting`/`tellStopped` is the whole of what it
 * takes to drive the page. It is deliberately not a simulator: it holds a
 * list, hands it out, and lets the mutating calls change it.
 *
 * It advances on every poll rather than serving a fixed list. A still list
 * renders once and proves only the first paint — it cannot show that the SSE
 * patch morphs a row in place, that an expanded `<details>` survives the
 * morph, or that a bar moves at all. The moving row therefore gains bytes,
 * and the resolving one resolves after a few seconds into a real download the
 * way a magnet does.
 *
 * Numbers go out as strings and booleans as "true"/"false" because that is
 * aria2's wire shape, not an oversight — `RawDownload` parses them back.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 6801);
const TV = process.env.MOCK_DIR ?? "/tv";

/** aria2 reports every counter as a decimal string. */
type Download = {
  gid: string;
  status: "active" | "waiting" | "paused" | "error" | "complete" | "removed";
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  uploadSpeed: string;
  connections: string;
  numSeeders: string;
  errorMessage?: string;
  dir: string;
  files: {
    index: string;
    path: string;
    length: string;
    completedLength: string;
    selected: string;
  }[];
  bittorrent?: { info?: { name?: string } };
  followedBy: string[];
};

const GiB = 1024 ** 3;

/**
 * A counter, the way aria2 writes one: a decimal string with no fractional
 * part. Rust parses these into `u64` and falls back to 0 on anything it
 * cannot read, so a plain `String(1.2 * GiB)` — which JavaScript renders as
 * `1288490188.8` — arrives as a download of size zero, and the row reads
 * "starting" forever. Every number below goes through here.
 */
const n = (value: number) => String(Math.round(value));

/**
 * One download. The file list is a single entry sized to match the totals,
 * which is all `selected_totals` needs — the filter's multi-file cases have
 * their own tests in `src/filter.rs` and are not what this is for.
 */
function download(
  gid: string,
  name: string,
  fields: Partial<Download> & { totalLength: string; completedLength: string },
): Download {
  return {
    gid,
    status: "active",
    downloadSpeed: "0",
    uploadSpeed: "0",
    connections: "0",
    numSeeders: "0",
    dir: `${TV}/${name}`,
    followedBy: [],
    bittorrent: { info: { name } },
    files: [
      {
        index: "1",
        path: `${TV}/${name}/${name}.mkv`,
        length: fields.totalLength,
        completedLength: fields.completedLength,
        selected: "true",
      },
    ],
    ...fields,
  };
}

/**
 * One per `Health`, plus the two rows that are a state of the list rather
 * than of a download: a queued one and a metadata pass.
 *
 * The names are invented but shaped like real release names, long ones
 * included — a row's layout is decided by its name far more than by its
 * numbers, and a tidy `test.iso` has never reproduced anything.
 */
function fixtures(): Download[] {
  return [
    // Resolving: a magnet with no metadata yet, so no size and no
    // percentage. aria2 names it this way and `all_downloads` keeps it
    // visible for as long as it is the only evidence the add happened.
    download("1000000000000001", "[METADATA]8f9c2b1d4e6a", {
      totalLength: "0",
      completedLength: "0",
      connections: "3",
    }),
    // Moving: the ordinary case, and the only row that advances below.
    download(
      "1000000000000002",
      "Some.Show.S02E04.2160p.WEB-DL.DDP5.1.HDR.H.265-GROUP",
      {
        totalLength: n(6 * GiB),
        completedLength: n(2 * GiB),
        downloadSpeed: n(3.4 * 1024 * 1024),
        uploadSpeed: n(180 * 1024),
        connections: "24",
        numSeeders: "11",
      },
    ),
    // Stalled: peers connected, nothing arriving. May recover on its own,
    // which is why it is not an error.
    download(
      "1000000000000003",
      "Static.Tide.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1",
      {
        totalLength: n(9 * GiB),
        completedLength: n(1.2 * GiB),
        connections: "6",
        numSeeders: "2",
      },
    ),
    // Can't connect: seeders exist and none is connected. Ordinary whenever
    // the peer port is not forwarded — see `upnp` in the README.
    download(
      "1000000000000004",
      "Marrow.Ridge.1984.2160p.UHD.BluRay.x265-SOMEONE",
      {
        totalLength: n(14 * GiB),
        completedLength: n(400 * 1024 * 1024),
        numSeeders: "9",
      },
    ),
    // No seeders: nothing to wait for, and the only row whose fix is a
    // different magnet.
    download("1000000000000005", "Obscure.Thing.1971.DVDRip.XviD", {
      totalLength: n(1.4 * GiB),
      completedLength: n(30 * 1024 * 1024),
    }),
    download("1000000000000006", "Another.Show.S01E01.1080p.WEB-DL", {
      status: "paused",
      totalLength: n(2 * GiB),
      completedLength: n(900 * 1024 * 1024),
    }),
    // Ready: every wanted byte has arrived and it is still seeding, which is
    // what `--seed-ratio=0.0` means and why this stays in the active list.
    download(
      "1000000000000007",
      "Quiet.Fault.1979.Criterion.1080p.BluRay.x264-CINEFILE",
      {
        totalLength: n(8 * GiB),
        completedLength: n(8 * GiB),
        uploadSpeed: n(620 * 1024),
        connections: "31",
        numSeeders: "0",
      },
    ),
    download("1000000000000008", "Broken.Release.2019.1080p.WEB-DL", {
      status: "error",
      totalLength: n(3 * GiB),
      completedLength: n(1 * GiB),
      errorMessage:
        "File /tv/Broken.Release.2019.1080p.WEB-DL exists, but a control file(*.aria2) does not exist.",
    }),
    download("1000000000000009", "Queued.Show.S03E07.1080p.WEB-DL", {
      status: "waiting",
      totalLength: n(2.5 * GiB),
      completedLength: "0",
    }),
  ];
}

let downloads = fixtures();

const MOVING = "1000000000000002";
const RESOLVING = "1000000000000001";
/** Polls before the magnet resolves — `routes::TICK_SECS` is one second. */
const RESOLVE_AFTER = 8;
let polls = 0;

/**
 * Called once per list poll, so what the page shows changes between SSE
 * patches. Only two rows move: everything else is a state, and a state that
 * drifted would stop being the thing it was put there to show.
 */
function advance() {
  polls += 1;

  const moving = downloads.find((d) => d.gid === MOVING);
  if (moving && moving.status === "active") {
    const speed = Number(moving.downloadSpeed);
    const done = Math.min(
      Number(moving.totalLength),
      Number(moving.completedLength) + speed,
    );
    moving.completedLength = n(done);
    moving.files[0].completedLength = n(done);
  }

  // The magnet resolves into the download `follow-torrent` spawns, and the
  // metadata gid moves to the stopped list — which is where `all_downloads`
  // sweeps it, so the real row replaces it rather than joining it.
  const resolving = downloads.find((d) => d.gid === RESOLVING);
  if (resolving && polls === RESOLVE_AFTER) {
    resolving.status = "complete";
    resolving.followedBy = ["1000000000000010"];
    downloads.push(
      download("1000000000000010", "Resolved.Show.S01E02.1080p.WEB-DL", {
        totalLength: n(1.8 * GiB),
        completedLength: "0",
        downloadSpeed: n(900 * 1024),
        connections: "8",
        numSeeders: "4",
      }),
    );
  }
}

const byStatus = (...wanted: Download["status"][]) =>
  downloads.filter((d) => wanted.includes(d.status));

/** In one of aria2's stopped lists, which is what the removal calls turn on. */
const isStopped = (d: Download) =>
  d.status === "complete" || d.status === "error" || d.status === "removed";

/** Gids whose first `removeDownloadResult` has been refused — see below. */
const discardAsked = new Set<string>();

/**
 * Only the methods `src/aria2.rs` actually calls. An unknown one is answered
 * with a JSON-RPC error rather than an empty result, so a method added on the
 * Rust side shows up here as a visible failure instead of an empty list.
 */
function dispatch(method: string, params: unknown[]): unknown {
  const gid = params[0] as string;
  const found = () => downloads.find((d) => d.gid === gid);

  switch (method) {
    case "aria2.tellActive":
      advance();
      return byStatus("active");
    case "aria2.tellWaiting":
      return byStatus("waiting", "paused");
    case "aria2.tellStopped":
      return byStatus("complete", "error", "removed");
    case "aria2.tellStatus": {
      const d = found();
      if (!d) throw new Error(`No such download: ${gid}`);
      return d;
    }
    case "aria2.pause":
    case "aria2.forcePause": {
      const d = found();
      if (d) {
        d.status = "paused";
        d.downloadSpeed = "0";
        d.uploadSpeed = "0";
      }
      return gid;
    }
    case "aria2.unpause": {
      const d = found();
      if (d) {
        d.status = "active";
        d.downloadSpeed = n(2 * 1024 * 1024);
      }
      return gid;
    }
    // The two removal calls apply to different downloads and each refuses the
    // other's, which is the distinction #316 turned on: deleting on either was
    // why a button that could only ever fail against the real aria2 worked
    // perfectly here. `remove` stops one that is still running;
    // `removeDownloadResult` discards one that has already stopped.
    case "aria2.remove":
    case "aria2.forceRemove": {
      const d = found();
      if (!d || isStopped(d))
        throw new Error(`GID#${gid} cannot be removed now`);
      d.status = "removed";
      return gid;
    }
    case "aria2.removeDownloadResult": {
      const d = found();
      if (!d || !isStopped(d)) throw new Error(`GID#${gid} is not found`);
      // Refused once, because aria2 is not finished when `remove` returns and
      // the client has to keep asking — which is also what makes the row's
      // "clearing" state long enough to see here.
      if (!discardAsked.has(gid)) {
        discardAsked.add(gid);
        throw new Error(`GID#${gid} is not found`);
      }
      discardAsked.delete(gid);
      downloads = downloads.filter((x) => x.gid !== gid);
      return gid;
    }
    case "aria2.addUri": {
      // Answers the way a magnet does: a metadata gid that resolves later,
      // which is the path `finish_add` polls. `changeOption` then applies a
      // selection to whatever `followedBy` names.
      const newGid = String(2000000000000000 + downloads.length);
      downloads.push(
        download(newGid, `[METADATA]${newGid.slice(-12)}`, {
          totalLength: "0",
          completedLength: "0",
        }),
      );
      return newGid;
    }
    case "aria2.changeOption":
      return "OK";
    default:
      throw new Error(`Unhandled method: ${method}`);
  }
}

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let payload: { id?: unknown; method?: string; params?: unknown[] } = {};
    try {
      payload = JSON.parse(body);
      const result = dispatch(payload.method ?? "", payload.params ?? []);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    } catch (e) {
      // aria2's own shape for a refusal, so the Rust side takes the same
      // path it would in production rather than one only this can produce.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          error: {
            code: 1,
            message: String(e instanceof Error ? e.message : e),
          },
        }),
      );
    }
  });
}).listen(PORT, () => {
  console.log(`mock aria2 on http://127.0.0.1:${PORT}/jsonrpc`);
  console.log(`${downloads.length} downloads, one per state`);
});
