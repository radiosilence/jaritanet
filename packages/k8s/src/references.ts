import type * as pulumi from "@pulumi/pulumi";
import { outputDetailsSecret, TunnelSchema } from "./references.schemas.ts";

export async function tunnelRef(stackRef: pulumi.StackReference) {
  const { secretValue: tunnel } = outputDetailsSecret(TunnelSchema).parse(
    await stackRef.getOutputDetails("tunnel"),
  );
  return tunnel;
}
