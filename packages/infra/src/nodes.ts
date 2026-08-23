/**
 * The machines, and what makes them different.
 *
 * Its own module because it imports nothing. `stack.ts` reaches stack config
 * the moment it loads, so anything importing it needs a live Pulumi context —
 * which is fine for the program and wrong for a unit test that only wants to
 * know what a node is called.
 */
/**
 * The machine holding the media drive.
 *
 * A hostname rather than a label because it pins a `local` PersistentVolume's
 * node affinity, which names a node. The daemonset-shaped file services select
 * `FILE_NODE_LABEL` instead — which machine holds the disks is a property of
 * that machine, applied by the seed drive when it joins.
 */
export const MEDIA_NODE = "lady";

/**
 * The machine with a datacentre uplink.
 *
 * The two nodes are not interchangeable and scheduling them as if they were is
 * how Hydra ended up on the home box with its Postgres left on the VPS — every
 * login crossing a residential line twice, and the whole estate's sign-in
 * depending on that line being up. Nothing chose it: an unconstrained pod goes
 * where the most capacity is unrequested, and the gateway looks full because it
 * carries the control plane, Cilium, Traefik, the transports and the metrics
 * stack.
 *
 * So anything whose availability should not depend on a house having power
 * names this. It is the same judgement `metrics.storageNode` already makes.
 */
export const CLOUD_NODE = "sympathy";
