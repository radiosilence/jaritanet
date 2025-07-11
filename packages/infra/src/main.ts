import { conf } from "./conf.ts";
import { createTunnel } from "./modules/tunnel.ts";

export const tunnel = createTunnel(conf.tunnel);
