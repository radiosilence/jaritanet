import { createTunnel } from "./modules/tunnel.ts";

export default async () => {
  const { conf } = await import("./conf.ts");
  return {
    tunnel: createTunnel(conf.tunnel),
  };
};
