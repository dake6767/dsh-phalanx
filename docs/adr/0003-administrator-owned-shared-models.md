# 0003: Administrator-owned shared models

Status: accepted for 0.1.1

## Context

A team needs shared supply from multiple compatible providers, configured in
management after installation. Model names can collide across providers. Provider
keys must stay outside member spaces, and routine changes should not interrupt
admitted requests or require a platform restart.

## Decision

Administrators maintain provider names, Messages Base URLs, keys and manual model
lists. This release supports Anthropic Messages only. Enabled models have stable
opaque route identities; the gateway maps each identity to its actual provider
and model name at request admission. The endpoint appends `/v1/messages` to the
configured Base URL. DeepSeek uses its `/anthropic` prefix; other providers use
their own prefix. Disabled or deleted selections fail explicitly, without a
fallback model. Replacing or removing the default requires an enabled replacement.

Protected platform storage owns the configuration. Management responses show
whether a key exists, allow replacement, and never return the stored key. Each
instance receives only a public catalog and its own opaque gateway token.
Revision checks prevent stale administrator writes. Each outgoing request retains
its admitted provider snapshot; later calls use the updated configuration.

An official nested include loads the exported generic DSH adapter and default
selection service. A platform-owned HMR watcher updates their configuration and
announces catalog changes. Container mounts are read-only. Normal member model
settings and corresponding operations are unavailable, while shared-model
selection, unrelated settings, terminals and user plugins remain available.

## Consequences

This supersedes the personal-provider override decision in ADR-0002 for 0.1.1.
It preserves the rootless isolation and authenticated network return path for
plugins. Members running arbitrary code can still contact external services or
interfere with their own process; this is not a network prohibition on external
models. Development mode does not promise filesystem protection.

Legacy deployment supply is imported only when shared storage is first created.
Subsequent administrator edits take precedence over old environment defaults.
Backing up and retiring old personal settings belongs to the upgrade procedure.
The model metadata uses conservative transport limits; it does not certify a
provider's maximum context length or multimodal capabilities.
