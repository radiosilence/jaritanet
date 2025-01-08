import type { LocalStorageServiceArgs, StaticServiceArgs } from "./templates";

export interface CloudflaredConf {
  name: string;
  args: {
    tokenRef: string;
  };
}

export interface LocalServiceConf {
  template: "local-storage";
  args: LocalStorageServiceArgs;
}
export interface StaticServiceConf {
  template: "static";
  args: StaticServiceArgs;
}

export type ServiceConf = { name: string; hostname: string } & (
  | LocalServiceConf
  | StaticServiceConf
);
