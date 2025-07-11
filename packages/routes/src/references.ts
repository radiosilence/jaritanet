import type * as pulumi from "@pulumi/pulumi";
import { z } from "zod/v4";
import { ServiceSchema } from "./conf.schemas.ts";
import {
  outputDetails,
  outputDetailsSecret,
  TunnelSchema,
} from "./references.schemas.ts";

export async function tunnelRef(stackRef: pulumi.StackReference) {
  const { secretValue: tunnel } = outputDetailsSecret(TunnelSchema).parse(
    await stackRef.getOutputDetails("tunnel"),
  );
  return tunnel;
}

export async function servicesRef(stackRef: pulumi.StackReference) {
  const { value: services } = outputDetails(
    z.record(z.string(), ServiceSchema),
  ).parse(await stackRef.getOutputDetails("services"));
  return services;
}
