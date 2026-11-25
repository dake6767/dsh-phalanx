# Official DSH seam ownership

Part of [Community platform architecture](../architecture.md). Every official DeepSeek Harness CLI, configuration, plugin, HTTP and WebSocket seam has one named owner under `src/dsh/`.

| Frozen seam | Owner | Caller/transport |
| --- | --- | --- |
| Expert preset projection, roster and pinned standard tools | `dsh/expert-preset.ts`, `dsh/expert-base-tools.ts`, `dsh/expert-plugins.ts` | `adapters/member-experts.ts`, `adapters/expert-status.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Protected MCP include and pre-admission hot refresh | `dsh/member-mcp.ts`, `dsh/member-tools.ts` | `adapters/mcp-projection.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Selected model display in native prompt variables | `dsh/shared-models.ts` | Per-space managed watcher through `system-prompt/assemble` |
| Web and composed-configuration CLI arguments | `dsh/cli.ts` | `adapters/community-runtime-driver.ts`, `adapters/native-config-dump.ts`, `dsh/container.ts`, generated image CMD |
| Private web-profile paths and patch layout | `dsh/profile-layout.ts` | `adapters/community-profile.ts`, `dsh/container.ts` |
| Member profile writer lock and Podman generation evidence | `dsh/profile-layout.ts`, `dsh/container-write-lock.ts` | `adapters/member-profile-write-lock.ts`, `adapters/container-write-lock.ts`, `adapters/community-containers.ts` |
| Non-root container identity, mounts and confined pasta return path | `dsh/container.ts` | `adapters/community-runtime-driver.ts` |
| Isolated npm installation and package artifact preparation | `dsh/plugin-preparation.ts` | `adapters/plugin-preparer.ts` |
| Uploaded package manifest inspection | `dsh/plugin-archive.ts` | `adapters/plugin-archive-inspector.ts` |
| Native bundle inventory, install, replacement and removal RPCs | `dsh/plugin-manager-protocol.ts` | `adapters/member-plugin-manager.ts`, `adapters/dsh-plugin-rpc.ts` |
| Access entry identities, lazy values and startup config merge | `dsh/managed-plugin-access.ts` | `adapters/plugin-access-syntax.ts`, `adapters/managed-plugins.ts` |
| Managed bundle patch conversion and protected includes | `dsh/managed-plugin-patch.ts` | `dsh/plugin-preparation.ts`, `adapters/managed-plugins.ts` |
| Self-installed bundle entry discovery and owned yielding patches | `dsh/plugin-coordination.ts` | `adapters/plugin-coordination.ts` |
| Offline plugin activation precheck through native inventory | `dsh/plugin-precheck.ts`, `dsh/plugin-service-observer.ts` | `adapters/plugin-preparer.ts` |
| CLI readiness and launch URL | `dsh/readiness.ts` | `adapters/runtime-process.ts` |
| Launch-token exchange cookies | `dsh/launch-token.ts` | `adapters/dsh-session.ts` |
| Session RPC, native mux frames and activity query | `dsh/session-protocol.ts` | `adapters/dsh-session.ts`; native traffic passes through the entry unchanged |
| Per-protocol gateway paths and supplier transport, bounded usage observation and default gateway URL | `dsh/model-protocol.ts`, `dsh/model-usage.ts` | `adapters/community-model-upstream.ts`, `inbound/community-model-gateway.ts` |
| DeepSeek Search API transport, member gateway paths and disabled Fetch boundary | `dsh/web-tools.ts` | `adapters/community-web-tools-upstream.ts`, `inbound/community-web-tools-gateway.ts` |
| Legacy profile defaults; workspace invocation overlay | `dsh/community-profile.ts` | `adapters/community-profile.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Web environment reset carriers | `dsh/community-environment.ts` | `adapters/community-environment.ts` |
| Global contribution tool, foreground confirmation and embedded guide | `dsh/contribution-tool.ts` | `adapters/community-platform-plugin.ts` |
| Native plugin detail contribution slots and new-session draft | `dsh/community-plugin-contributions-client.ts` | `dsh/community-platform-client.ts` |
| Best-effort platform skill-result observation and report endpoint | `dsh/skill-usage.ts` | `adapters/community-platform-plugin.ts`, `adapters/community-runtime-driver.ts`, `inbound/usage-report-gateway.ts` |
| Protected platform plugin and invocation patch | `dsh/community-platform-plugin.ts` | `adapters/community-platform-plugin.ts`, `dsh/container.ts` |
| Per-member final native-feature patch and build-time entry bindings | `dsh/native-features.ts` | `adapters/member-native-features.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Built-in preset declarations, effective default reads, revisioned repair and Creator entry slots | `dsh/native-presets.ts`, `dsh/native-preset-client.ts` | `adapters/community-runtime-driver.ts`, `adapters/member-native-features.ts` |
| Creator and fetch tool policy from official composed configuration | `dsh/native-creator-tools.ts` | `adapters/native-config-dump.ts`, `adapters/member-native-feature-launch.ts` |
| Native bundle access policy, platform install proof and localized refusals | `dsh/native-plugin-policy.ts`, `dsh/native-plugin-install.ts`, `dsh/native-plugin-replacement.ts`, `dsh/native-feature-locale.ts` | `adapters/member-native-features.ts`, `adapters/native-install-transport.ts` |

DSH remains an external frozen dependency. Upgrade these seam owners against its
official interfaces before changing transport. Unrelated native Settings, account-login surfaces and user plugins belong to each member. Shared model supply belongs to platform administration through the official managed include in `dsh/shared-models.ts`.
The built-in custom plugin market bundle is omitted from native bundle discovery
and its enable request is refused. Protected invocation patches disable its host
and client entries even when a member edits bundle selection. Other bundle
operations retain native Gateway validation and behavior. A member Host module reads the public preset registry’s live effective default before admission. Only a disabled built-in default is repaired through revisioned Settings; the member’s registry configuration and other default choices are preserved. Group native-feature
choices apply on the next instance start. Disabling self-installation refuses
browser installation and first-time official optional bundles, while preserving
existing bundle management and platform App Center deliveries. Unconfined `web_fetch` is disabled in composed root and preset configuration, with a deployment tool guard refusing later same-name registrations. The public tool service composition waits for platform MCP refresh before resolving each step; obsolete registrations remain subject to native admission identity checks. Creator tools are
removed through a complete preset configuration derived from the official CLI's
composed configuration output; lazy expressions remain unevaluated.

Member containers receive a bounded stop grace period before removal. The data
root mutex and per-member lifecycle serialize platform profile preparation,
probes, carriers and resets. Each independently admitted execution records a
new durable writer revision before mounting the member home. The platform
checks that revision and the home inode against the values recorded when a
carrier started with no existing lock or overlapping writer. At retirement it
also verifies the exited private PID namespace. A live legacy carrier needs
evidence from its mounted home, profile, lock and process, plus retained
Podman file events for the generation.

The platform takes the same record claim that DSH rc.3 uses for lock takeover.
It isolates the actual lock inode with an atomic exchange and uses a guard that
DSH treats as an incomplete record. The recovery journal lets the platform
finish disposing of a proven inode or restore a displaced replacement after
interruption. It retains uncertain locks, diagnoses the reason, and holds the
next profile write until the lock can be resolved.

The group App Center setting is a separate positive flag that defaults to off.
The platform client reads it for the current authenticated member on page load.
An unavailable read leaves both App Center slots unregistered. Market APIs and
resource grants use their existing authorization rules.

`NativePluginHistory` owns append-only optional-bundle eligibility in PostgreSQL,
scoped to the active account space. Its first baseline uses currently enabled or
installed bundles; later observations retain successful enabled choices. The instance starts
synchronizing in the background after registration. One observation runs at a
time per launch, and temporary failures retry with bounded backoff. Member
callbacks can request a refresh after a native change. The platform rechecks the
current account and launch before recording facts, and stopping the instance
cancels its pending observations and waits for any transaction that has reached
the commit boundary. If the first baseline is still pending, only optional
bundle operations that require that baseline ask the member to retry. CLI
changes that are enabled and disabled between observations do not supply
historical proof.

Platform native installation uses a distinct authenticated Connection endpoint.
An in-memory Ed25519 key signs the exact method, path, body digest, member, launch,
expiry and one-use nonce. Only its public key enters the immutable member mount.
The endpoint and signing key exist only in container mode, matching the existing
platform native-install capability. Host mode supplies no private endpoint.
Group feature controls are product policy, not isolation from members who can
execute their own code or change their own DSH configuration.
