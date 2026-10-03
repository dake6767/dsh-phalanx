#!/bin/sh
# Image-build-only tool supply; the frozen DSH tree is untouched.
set -eu
mkdir -p /opt/dsh-phalanx
curl -fsSL --retry 3 https://bootstrap.pypa.io/pip/zipapp/pip-26.2.1.pyz -o /opt/dsh-phalanx/pip.pyz
printf '%s\n' '91d5fd9f6f25549fd839c60536c6f1b945316ce3588d34a605635b6071c91526  /opt/dsh-phalanx/pip.pyz' | sha256sum -c -
printf '%s\n' '#!/bin/sh' 'exec python3 /opt/dsh-phalanx/pip.pyz "$@"' > /usr/local/bin/pip
chmod 755 /usr/local/bin/pip
ln -sf pip /usr/local/bin/pip3
