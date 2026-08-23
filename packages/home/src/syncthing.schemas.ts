import * as z from "zod";
import { AbsolutePath } from "@jaritanet/k8s";

/**
 * A synced tree. Same reasoning as a samba share: `hostPath`, because the disk
 * is physically attached to one machine.
 *
 * Unlike a share this is mounted read-write, and that is not the same risk. An
 * anonymous SMB export authorises by reachability, which is why it is read-only
 * and why NFS was deleted rather than narrowed. Syncthing authorises by
 * cryptographic device pairing over an encrypted link, so the set of things
 * that can write here is the set of devices deliberately paired with this one.
 *
 * The risk that *does* apply is deletion: syncthing propagates them, which is
 * the point when a bad rip is removed and a catastrophe when a laptop's disk
 * presents as empty. File versioning on the receiving side is the guard, and it
 * is a per-folder setting rather than anything expressible here.
 */
export const SyncthingFolderSchema = z.object({
  name: z.string(),
  hostPath: AbsolutePath,
});

/**
 * Syncthing on the node that holds the disks.
 *
 * `hostNetwork`, so local discovery (21027/udp) reaches peers on the LAN
 * directly and a laptop at home syncs at wire speed rather than through the
 * tailnet or a relay. Away from home it falls back to those on its own.
 *
 * Runs as `uid`/`gid` rather than root, which matters more here than it looks:
 * syncthing *creates* files, and they have to land owned by whoever owns the
 * media or navidrome and samba will not be able to read what it writes.
 * `fsGroup` cannot do this — kubelet does not apply it to hostPath volumes — so
 * the process itself has to be the right user. Nothing here binds a privileged
 * port, so unlike samba there is no reason to start as root at all.
 *
 * Folder layout and device pairing stay in syncthing's own config: the device
 * identity is a keypair generated on first run, and pairing is a deliberate act
 * between two devices. What is declared here is the machine it runs on, the
 * disks it can see, and where its state lives.
 */
export const SyncthingConfSchema = z.object({
  image: z.string().default("docker.io/syncthing/syncthing:2.0.13"),
  /**
   * Where the device identity, keys and folder config live. On the boot disk
   * rather than the media drive: it is small, and it must survive the media
   * drive being unmounted or replaced.
   */
  configPath: AbsolutePath.default("/var/lib/syncthing"),
  folders: z.array(SyncthingFolderSchema).min(1),
  /**
   * Hostname for the web UI, behind Traefik. Omit and the UI is reachable only
   * on the LAN and the tailnet at `:8384`.
   */
  gid: z.number().default(1000),
  uid: z.number().default(1000),
});
