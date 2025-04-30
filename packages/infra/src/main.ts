import { conf } from "./conf";
import { createTunnel } from "./modules/tunnel";

export const tunnel = createTunnel(conf.tunnel);
