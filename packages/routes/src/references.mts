import type * as pulumi from "@pulumi/pulumi";
import { z } from "zod";
import { ServiceSchema } from "./conf.schemas.mts";
import {
  TunnelSchema,
  outputDetails,
  outputDetailsSecret,
} from "./references.schemas.mts";

export const createReferences = async () => {
  const getTunnel = async (stackRef: pulumi.StackReference) => {
    const { secretValue: tunnel } = outputDetailsSecret(TunnelSchema).parse(
      await stackRef.getOutputDetails("tunnel"),
    );
    return tunnel;
  };

  const getServices = async (stackRef: pulumi.StackReference) => {
    const { value: services } = outputDetails(z.array(ServiceSchema)).parse(
      await stackRef.getOutputDetails("services"),
    );
    return services;
  };
  return {
    getTunnel,
    getServices,
  };
};
