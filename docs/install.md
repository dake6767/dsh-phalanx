# Debian-family installation

[简体中文](install.zh-CN.md)

The installer supports Debian-family amd64 hosts with sudo access. Ubuntu 24.04
and 26.04 are verified; other family distributions are unverified. The installer
supplies host packages, a dedicated rootless Podman identity, the bundled
runtime, the verified platform package and its matching DSH image. Deployers do
not need development Node.js, pnpm, GitHub CLI or a local image build.

## Host requirements

Admission uses the host's `ID` and `ID_LIKE` distribution-family fields, followed
by capability checks. Ubuntu 24.04 and 26.04 form the verified list. Other
Debian-family hosts receive an unverified warning without another confirmation;
passing the checks does not put a distribution on that list. Non-Debian-family
hosts are refused before host changes.

The host needs Podman **4.9.3 or newer**, passt **0.0~git20240220 or newer**,
systemd with a working user manager, cgroup v2 and working rootless Podman.
The installer prepares apt packages before checking these capabilities. When
`pasta --version` cannot identify its version, the installed passt package
version is checked. Unknown or insufficient capabilities fail with diagnostics
showing the requirement and actual package versions. A failed capability check
can leave prepared OS packages; a fresh install has not yet created its product
identity or deployment configuration.

Public installation targets Linux amd64. See the [Mac development VM](../CONTRIBUTING.md#mac-development-vm) for local Linux arm64 development
and validation.

Bundle installation with `--bundle-dir` is guaranteed only on the verified
Ubuntu releases. Missing OS dependencies still require available apt sources. Other Debian-family
hosts have no offline-install guarantee. One-time distribution verification is
recorded in the [release notes](../releases/notes/).

## Public release path

See [Releases](https://github.com/dake6767/dsh-phalanx/releases) for completed stable versions:

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

The default resolves GitHub’s latest completed stable Release and excludes previews.
To select a version explicitly, run `sudo bash install.sh --version vX.Y.Z`.
If `curl` is absent, install it with `sudo apt-get update && sudo apt-get install -y curl`,
or download the standalone script through a browser and transfer it to the host.
The platform package and image digest come from the same Release manifest;
checksums, tag commit and image identity must agree. The image is pulled from
`ghcr.io/dake6767/dsh-phalanx` by digest. Installation does not register an
automatic updater. Anonymous public download and pull are verified at release.

No model key is required. The first screen chooses Simplified Chinese or English,
with Chinese as the default; use `--language en` to select English explicitly.
Choose Official (the default), Mainland China or custom download sources before
the first release lookup. Language does not change the source. Supply the server
access IP and entry port (default 18080), then accept the suggested HTTP browser
URL or enter the actual HTTP/HTTPS domain. The URL does not configure certificates
or a reverse proxy. Bracketed values are defaults; press Enter to accept them.
Advanced gateway/storage settings are optional; invalid input stays on its
question, and the summary supports editing or cancellation.

Port forwarding/public NAT is a separate declaration, defaulting to No when
confirmed with Enter. An explicit empty `--host-public-addresses ''` means no
additional public ingress aliases; it permits normal public egress while host,
private, loopback and declared NAT targets remain protected. An undeclared
inventory continues to block member egress. The server access IP and a shared
public egress address are not substitutes for the mapping declaration.

For unattended installation, provide explicit facts and disable terminal input:

```sh
sudo bash install.sh --non-interactive --language en \
  --public-origin http://192.0.2.10:18080 --host-public-addresses '' --output json
```

Replace the example origin with the deployment's actual browser address. JSON
selects structured output; `--non-interactive` disables questions even with a
terminal. Upgrade interruption still requires its separate `--yes` confirmation.

For a first installation on a separate member volume, mount it before installing and pass both `--user-data-root` and `--user-data-mount`. See [the external volume requirements](operations.md#separate-user-storage). Optional [download source and proxy settings](operations.md#download-sources) also apply on first installation.

Use `--gateway-port PORT` when a host needs a specific unused private gateway
port. The default is 3081. On a first installation, the installer can choose and
save an available port if that default is occupied. Explicit and saved choices
require a matching port. The gateway listener stays on loopback, and
reinstallation uses the saved setting.

## HTTPS on a custom port

Run a dedicated reverse proxy in front of the installed platform. The supplied
[nginx configuration](../deploy/nginx/https.conf.example) and
[systemd unit](../deploy/nginx/dsh-phalanx-edge.service.example) use an independent
`dsh-phalanx-edge` identity and process, leaving other nginx services alone.
NGINX 1.24 or later is supported by these explicit HTTP/1.1 WebSocket settings.

Before configuring TLS, verify that your chosen external port can reach a
short-lived listener on the server. Configure the platform with a loopback
listener and its exact public HTTPS origin, including the port. Select a private
gateway port that is free on the existing host (default3081):

```sh
sudo bash install.sh --version vX.Y.Z \
  --host-public-addresses 198.51.100.10 \
  --listen-address 127.0.0.1 --port 18080 --gateway-port 41081 \
  --public-origin https://198.51.100.10:18443
```

Replace the example address with the complete inventory of your server's public
IPv4 addresses. Supply the platform and matching image from the same verified
release. Existing protected platform configuration must be edited explicitly;
the installer refuses to silently replace deployment facts on repetition.

Create the edge identity with a locked password and no login shell. Install a
certificate with a Subject Alternative Name covering the exact IP (or DNS name)
used by the browser. Store its private key outside the repository, readable only
by the edge identity. Render the example paths/address, install the dedicated
configuration and unit, then validate with `nginx -t` before enabling the unit.
The unit supplies its own writable runtime directory and graceful shutdown.

For a private test CA, import the **public CA certificate** into each tester's
trust store, verifying its fingerprint through the deployment channel. Keep the
CA signing key on the deployment workstation. Certificate dates, chain and IP
matching must validate normally; browser acceptance must leave
`ignoreHTTPSErrors` disabled. Remove the specific test CA trust when the preview
ends. A public deployment should use a normally trusted certificate and its
own renewal procedure; this template does not obtain or renew certificates.

The proxy preserves the incoming Host including its port and forwards Upgrade
and Connection for WSS. Response buffering is disabled for streaming. The
platform's public origin controls relative login redirects and Secure cookies;
the backend stays HTTP on loopback. Keep the model gateway and all container
published ports on loopback too. Port 18080 in this setup is local debugging
only; the external product entry is HTTPS on 18443.

Verify browser bootstrap/login, account management, native streaming and actual
WSS frames using the trusted entry. Check externally that backend/gateway and
instance ports cannot be reached. Developer HTTPS checks are documented in [Contributing](../CONTRIBUTING.md).

To stop this preview, stop and disable only `dsh-phalanx-edge.service` and the
installer-owned user's `dsh-phalanx.service`. Preserve user data/configuration.
Remove only this unit/configuration/certificate and its runtime directory when
retiring it. Restart or rollback the installed platform using its recorded
release/configuration; do not restart shared nginx or prune other identities'
containers.

References: [NGINX WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
and [Host forwarding](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

## Initialize the platform

Open the installer's `initializationUrl` in a browser. The link contains a secret, expires after 24 hours and is consumed when the first administrator is created. The installer displays it in its final output.

1. In **Platform database**, keep **Built-in PostgreSQL** or choose **External PostgreSQL**. For an external server, enter its connection details and run **Test connection**. PostgreSQL 14 or newer and a role that owns or can create the `dsh_phalanx` schema are required. Start with an empty schema or the matching platform database. Use `verify-full` to verify the server certificate and hostname. A private CA may be pasted or uploaded. More about TLS and recovery is in the [operations guide](operations.md#database-switching-and-key-rotation).
2. Create the first administrator with a username and password. Email is optional. The platform signs you in and opens the optional first-model form.
3. Save one provider key and one enabled default model, or choose **Skip for now and finish installation** to enter `/admin`. Saving verifies the configuration format. To check that the model answers, send a message from DSH once the member can enter. After skipping, terminal and workspace access still work. See [Shared models](admin-guide.md#shared-models) for provider protocols and model settings.
   If publication fails after the provider is saved, reload the first-model
   page and select **Retry model publication**. The saved provider and
   revision are reused. A deployer can [prefill the first-model form](operations.md#prefill-the-first-model-form) before this step.
4. Open **Account management** and create a member account. Sign in as that member and confirm DSH opens. From the member row, an administrator can also confirm entry with **Switch to this member’s DSH** and the member's password. See the [member guide](member-guide.md) for the account and space experience.

If you need a new initialization link before the first account is created, see [Recover the initialization link](operations.md#recover-the-initialization-link). Start a [consistent backup](operations.md#consistent-backup-and-whole-host-migration) once the deployment is in use. Keep the matching master key in a separate offline backup.

## Next steps

- [Operations](operations.md) for backups, upgrades, storage changes and recovery.
- [Administrator guide](admin-guide.md) for accounts, models, DSH features and distributing resources.
- [Member guide](member-guide.md) for DSH, Platform Apps, files and instance recovery.

## Installer output and diagnostics

Use the final summary to confirm local readiness and find the initialization
link. Check browser access on the reported port, firewall or security group,
and reverse proxy. If installation fails, keep the data and configuration and
correct the reported issue before rerunning the verified installer. See
[installer output and diagnostics](operations.md#installer-output-and-diagnostics)
for the log location, JSON output and service journal command.

## CLI simulation

From a source checkout, run `python3 scripts/install/preview.py` to rehearse the installation questions. Use `--language en` for English. The preview never downloads assets or operates real services. For the other deployment commands, see [deployment CLI simulation](operations.md#deployment-cli-simulation).

## Moved sections

<a id="storage-layout"></a>

- [Storage layout](operations.md#storage-layout)

<a id="security-boundary"></a>

- [Security boundary](operations.md#security-boundary)

<a id="master-key-backup"></a>

- [Master key backup](operations.md#master-key-backup)

<a id="database-switching-and-key-rotation"></a>

- [Database switching and key rotation](operations.md#database-switching-and-key-rotation)

<a id="consistent-backup-and-whole-host-migration"></a>

- [Consistent backup and whole-host migration](operations.md#consistent-backup-and-whole-host-migration)

<a id="download-sources"></a>

- [Download sources](operations.md#download-sources)

<a id="egress-proxy"></a>

- [Egress proxy](operations.md#egress-proxy)

<a id="separate-user-storage"></a>

- [Separate user storage](operations.md#separate-user-storage)

<a id="service-management-and-recovery"></a>

- [Service management and recovery](operations.md#service-management-and-recovery)

<a id="uninstall-and-recover-a-deployment"></a>

- [Uninstall and recover a deployment](operations.md#uninstall-and-recover-a-deployment)

<a id="move-user-storage-to-another-mounted-volume"></a>

- [Move user storage to another mounted volume](operations.md#move-user-storage-to-another-mounted-volume)

<a id="recoverable-system-updates"></a>

- [Recoverable system updates](operations.md#recoverable-system-updates)

<a id="office-preview-fonts"></a>

- [Office preview fonts](member-guide.md#office-preview-fonts)

<a id="downloading-artifacts"></a>

- [Downloading artifacts](member-guide.md#downloading-artifacts)

<a id="interactive-html-files"></a>

- [Interactive HTML files](member-guide.md#interactive-html-files)

<a id="personal-skill-keys"></a>

- [Personal skill keys](member-guide.md#personal-skill-keys)

<a id="switching-accounts-in-this-browser"></a>

- [Switching accounts in this browser](member-guide.md#switching-accounts-in-this-browser)

<a id="member-logout-and-recovery"></a>

- [Member logout and recovery](member-guide.md#member-logout-and-recovery)

<a id="member-instances"></a>

- [Member instances](admin-guide.md#member-instances)

<a id="groups-and-plugins"></a>

- [Groups and plugins](admin-guide.md#groups-and-plugins)

<a id="platform-app-center-and-mcp"></a>

- [Platform app center and MCP](admin-guide.md#platform-app-center-and-mcp)

<a id="skills"></a>

- [Skills](admin-guide.md#skills)

<a id="skill-packs-and-multi-skill-imports"></a>

- [Skill packs and multi-skill imports](admin-guide.md#skill-packs-and-multi-skill-imports)

<a id="git-sources-and-updates"></a>

- [Git sources and updates](admin-guide.md#git-sources-and-updates)

<a id="administrator-environment-recovery"></a>

- [Administrator environment recovery](admin-guide.md#administrator-environment-recovery)

<a id="private-candidate-validation"></a>

- [Private candidate validation](../CONTRIBUTING.md#candidate-contract)

<a id="entry-and-durable-state"></a>

- [Entry and durable state](operations.md#storage-layout)

<a id="configuration-and-supported-scope"></a>

- [Configuration and supported scope](#host-requirements)

<a id="installer-progress"></a>

- [Installer progress](#installer-output-and-diagnostics)

<a id="private-http-service-previews"></a>
<a id="usage-records"></a>

The former entry points are temporarily unavailable. Existing data is retained.
