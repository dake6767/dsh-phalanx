# Upgrade tool supply on an already accepted frozen image without rebuilding DSH.
ARG DSH_IMAGE
FROM ${DSH_IMAGE}
# Root is used only while constructing the filesystem, as in the base build.
# Runtime invocations remain non-root and keep-id.
USER root
COPY install-pip.sh /tmp/dsh-phalanx-install-pip.sh
RUN sh /tmp/dsh-phalanx-install-pip.sh && rm /tmp/dsh-phalanx-install-pip.sh
COPY install-browser-libraries.sh /tmp/dsh-phalanx-install-browser-libraries.sh
RUN sh /tmp/dsh-phalanx-install-browser-libraries.sh && rm /tmp/dsh-phalanx-install-browser-libraries.sh
USER node
