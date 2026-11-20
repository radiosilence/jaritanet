# Upstream's Hysteria2 image, able to bind :443 without root.
#
# The gateway runs hysteria on the host network, where binding a port below
# 1024 needs CAP_NET_BIND_SERVICE in the effective set. Kubernetes gives an
# added capability to uid 0 alone (there are no ambient capabilities), and a
# hostNetwork pod shares the host's ip_unprivileged_port_start. A file
# capability on the binary is the remaining route: exec grants it to whoever
# runs the binary, provided NET_BIND_SERVICE is in the container's bounding
# set, which the pod spec adds and nothing else does. The kernel honours it
# under no_new_privs, so the pod keeps allowPrivilegeEscalation: false.
#
# Built FROM upstream rather than from source, so this image is upstream's
# release plus one extended attribute. The base is tracked by the version
# updater, which bumps VERSION with it so a new base releases.
FROM docker.io/tobyxdd/hysteria:v2.14.0

RUN apk add --no-cache libcap-setcap \
 && setcap cap_net_bind_service=+ep /usr/local/bin/hysteria \
 && apk del libcap-setcap

USER 65534:65534
