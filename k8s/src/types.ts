import type { LocalServerArgs } from "./templates";

interface LocalServerConf {
  name: string;
  template: "local-server";
  args: LocalServerArgs;
}

// interface WebServerConf {
//   name: string;
//   template: "web-server";
//   args: unknown;
// }

export type ServersConf = LocalServerConf[];
