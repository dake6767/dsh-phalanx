# 0002: Rootless user spaces and overridable model defaults

Status: accepted

## Context

Each member needs a private home/workspace and persistent native choices. A
small-team deployer should configure a model credential once, without exposing
that shared credential to member processes. Members still need personal models
and native plugins to work through supported network access.

## Decision

Installed deployments use rootless Podman, one associated user instance per
account, independent private data mounts and loopback published ports. The host
platform owns account admission and instance lifecycle. Process mode remains a
local development option and provides no filesystem or network isolation.

A minimal authenticated gateway supplies the configured default model and injects
the shared upstream credential only at the outgoing transport. Private durable
per-user access tokens are distinct from the provider key. Native writable
profiles receive missing defaults, below explicit user choices; restarting must
not overwrite personal model or plugin configuration.

The private gateway also provides authenticated HTTP/CONNECT access for native
personal providers and plugin loading. It validates fresh account state, pins
public IPv4 results and rejects host aliases from the complete deployment
inventory. Direct container access stays confined by the supported pasta setup.
Omitting the inventory closes external proxy access while keeping the default
model route available. The gateway has no account-policy editing or usage UI.

## Alternatives and consequences

Requiring every member to configure a model creates unnecessary first-use work.
Forcing every conversation through one immutable model conflicts with native
user configuration. Removing the gateway would distribute shared credentials or
leave no supported private return route. Overridable defaults balance a usable
first conversation with member control.

Rootless operation adds Linux/Podman and host setup requirements; real container
and network tests are necessary. Personal configurations and plugins can fail
independently of the platform default. This is an isolation boundary for the
supported deployment, not a multi-distribution or untrusted-plugin certification
promise. DSH itself remains unchanged and retains its own license.
