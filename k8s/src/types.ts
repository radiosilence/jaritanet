import type { LocalServerArgs } from "./templates";

interface LocalServerConf {
  name: string;
  template: "local-server";
  args: LocalServerArgs;
}

interface WebServerConf {
  name: string;
  template: "web-server";
}

export type ServersConf = (LocalServerConf | WebServerConf)[];
