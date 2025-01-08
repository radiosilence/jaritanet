import type { LocalServerArgs } from "./templates";

export interface LocalServerConf {
  name: string;
  hostname: string;
  args: LocalServerArgs;
}

export interface CloudflaredConf {
  name: string;
  args: {
    tokenRef: string;
  };
}

// interface WebServerConf {
//   name: string;
//   template: "web-server";
//   args: unknown;
// }

export type ServersConf = (LocalServerConf | CloudflaredConf)[];
