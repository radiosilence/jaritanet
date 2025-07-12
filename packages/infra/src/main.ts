import { conf } from "./conf.ts";
import { createTunnel } from "./modules/tunnel.ts";

export default async () => {
  return {
    tunnel: createTunnel(conf.tunnel),
  };
};
