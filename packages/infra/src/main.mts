import { conf } from "./conf.mts";
import { createTunnel } from "./modules/tunnel.mts";

export const tunnel = createTunnel(conf.tunnel);
