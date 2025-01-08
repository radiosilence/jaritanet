import type { LocalServerArgs } from "./templates";

export interface LocalServerConf {
  name: string;
  hostname: string;
  template: "local-server";
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

export type ServiceConf = LocalServerConf;
