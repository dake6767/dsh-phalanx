#!/bin/sh
# Redistributable fonts for the official Office converter; no upstream edits.
# Debian's signed package metadata verifies the downloaded packages. Keep the
# package copyright files under /usr/share/doc in the runtime image.
set -eu
apt-get update
apt-get install -y --no-install-recommends \
  'fonts-noto-cjk=1:20220127+repack1-1' \
  'fonts-liberation2=2.1.5-1' \
  'fonts-crosextra-carlito=20220224-1' \
  'fonts-crosextra-caladea=20200211-1'
rm -r /var/lib/apt/lists/*
