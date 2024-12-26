# cf-tunnel

local cmd

```
helm install cf-tunnel . --set token="$(terraform -chdir=../terraform output -raw jaritanet_tunnel_token)"
```
