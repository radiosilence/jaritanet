import type * as pulumi from "@pulumi/pulumi";
import { z } from "zod";
import { ServiceSchema } from "./conf.schemas.mts";
import {
  TunnelSchema,
  outputDetails,
  outputDetailsSecret,
} from "./references.schemas.mts";

export async function tunnelRef(stackRef: pulumi.StackReference) {
  const { secretValue: tunnel } = outputDetailsSecret(TunnelSchema).parse(
    await stackRef.getOutputDetails("tunnel"),
  );
  return tunnel;
}

export async function servicesRef(stackRef: pulumi.StackReference) {
  const { value: services } = outputDetails(z.array(ServiceSchema)).parse(
    await stackRef.getOutputDetails("services"),
  );
  return services;
}
