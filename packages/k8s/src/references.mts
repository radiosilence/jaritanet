import type * as pulumi from "@pulumi/pulumi";
import { TunnelSchema, outputDetailsSecret } from "./references.schemas.mts";

export const createReferences = async () => {
  const getTunnel = async (stackRef: pulumi.StackReference) => {
    const { secretValue: tunnel } = outputDetailsSecret(TunnelSchema).parse(
      await stackRef.getOutputDetails("tunnel"),
    );
    return tunnel;
  };

  return {
    getTunnel,
  };
};
