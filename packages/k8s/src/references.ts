import type * as pulumi from "@pulumi/pulumi";
import { TunnelSchema, outputDetailsSecret } from "./references.schemas.ts";

export async function tunnelRef(stackRef: pulumi.StackReference) {
  const { secretValue: tunnel } = outputDetailsSecret(TunnelSchema).parse(
    await stackRef.getOutputDetails("tunnel"),
  );
  return tunnel;
}
