#!/bin/sh
# System libraries for prepared headless Chromium tools in member containers.
# The browser executable remains a frozen MCP dependency, never a runtime download.
# Package names follow Playwright's Debian 12 Chromium dependency manifest;
# signed Debian metadata verifies packages and preserves their copyright notices.
set -eu
apt-get update
apt-get install -y --no-install-recommends \
  'libasound2=1.2.8-1+b1' \
  'libatk-bridge2.0-0=2.46.0-5' \
  'libatk1.0-0=2.46.0-5' \
  'libatspi2.0-0=2.46.0-5' \
  'libcairo2=1.16.0-7' \
  'libcups2=2.4.2-3+deb12u9' \
  'libdbus-1-3=1.14.10-1~deb12u1' \
  'libdrm2=2.4.114-1+b1' \
  'libgbm1=22.3.6-1+deb12u2' \
  'libglib2.0-0=2.74.6-2+deb12u9' \
  'libnspr4=2:4.35-1' \
  'libnss3=2:3.87.1-1+deb12u4' \
  'libpango-1.0-0=1.50.12+ds-1' \
  'libx11-6=2:1.8.4-2+deb12u2' \
  'libxcb1=1.15-1' \
  'libxcomposite1=1:0.4.5-1' \
  'libxdamage1=1:1.1.6-1' \
  'libxext6=2:1.3.4-1+b1' \
  'libxfixes3=1:6.0.0-2' \
  'libxkbcommon0=1.5.0-1' \
  'libxrandr2=2:1.5.2-2+b1'
rm -r /var/lib/apt/lists/*
