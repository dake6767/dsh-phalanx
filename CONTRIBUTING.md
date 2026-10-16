# Development and contribution

Start in a new directory with a source checkout:

```sh
git clone https://github.com/dake6767/dsh-phalanx.git
cd dsh-phalanx
```

For the complete product on an Apple Silicon Mac, use the [development VM](#mac-development-vm).
Direct host development uses Git, Node.js 24.21.0 and Corepack with pnpm 11.19.0. The external DSH
build also needs its [upstream build prerequisites](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/README.md); the platform does not install developer build tools. Exact dependency versions are
recorded in the manifests and frozen lockfile. `runtime-versions.json` records
the supported external DSH revision: `dsh-v0.2.1-alpha.2`, an upstream prerelease. Python 3.12 or newer is required for installer tests and for reading member skill directory names safely through directory descriptors. Keep `python3` available on the platform service PATH. Edit installer sources under `scripts/install/`, then regenerate
the standalone entry with `node scripts/install/build-installer.mjs`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check:fast
```

The fast check runs typechecking, architecture lint, all quick tests, the service
build and the account-management UI build. Generated output lives in `dist/`
and `admin-ui/dist/`.

## Mac development VM

Install [Homebrew](https://brew.sh/) and Lima (`brew install lima`). No host Node,
pnpm, Podman or model credential is needed for this entry. In the checkout run:

```sh
bash scripts/dev/vm.sh up
```

The command creates a dedicated Ubuntu 24.04 arm64 Lima VM, builds the current
checkout there, and runs the real installer with local development artifacts.
Open `http://127.0.0.1:18080/`; the local terminal prints the one-time administrator
signup link. The initial model returns a fixed development response without
calling an external provider. Add real providers and their credentials through
Administration when needed; keep credentials out of checkout files and commands.

The VM uses four CPUs, 6 GiB memory and a 40 GiB disk. Reserve 16 GiB host memory
and 40 GiB free host disk before the first build. Rebuilds require 12 GiB free
on both the host and guest; a fresh guest needs 24 GiB free for its first build.
Cold native builds can take tens of minutes. The Mac checkout is mounted read-only;
Git-visible files are copied to Linux storage, while ignored files stay on the Mac.
A separate builder account keeps build caches out of the product's rootless store.
The owned VM uses Lima's host clock synchronization. Both `up` and `test` disable
guest NTP and restart the VM once when adopting this setting, clearing previous
NTP clock adjustments. This avoids competing time services moving the clock
backward and rejecting newly issued browser authentication cookies. The setting
persists across guest restarts; later commands reuse it.
The recorded development snapshot identifies these exact copied bytes, including
uncommitted edits. It is not a published source commit.

Edit source on the Mac and run `up` again. Changed snapshots use the normal
backup, stop, switch, verify and recovery transaction. Same-version rebuilds
require the explicit arm64 development mode and a local bundle; formal upgrade
compatibility stays unchanged. An unchanged snapshot is checked for readiness.

```sh
bash scripts/dev/vm.sh up --source official
bash scripts/dev/vm.sh test
bash scripts/dev/vm.sh logs
bash scripts/dev/vm.sh shell
bash scripts/dev/vm.sh down
bash scripts/dev/vm.sh destroy
```

If the Mac network synthesizes `198.18.0.0/15` registry addresses, the owned VM
refreshes a marked `/etc/hosts` block for npm and its known CDN using public
HTTPS DNS answers. Only globally routable answers are accepted; the Mac DNS
configuration and product private-address restrictions remain unchanged.
The block is refreshed before builds and T2, and disappears with the VM.

The default source preset is `mainland`; `official` is explicit. Presets are owned by
`src/domain/download-source-presets.json`; the installer embeds generated data
from that file. CI and validation use `python3 scripts/download-sources.py
--preset official -- <command>` (use `mainland` for mainland validation). The
shared T2 host accepts `--source-preset`. Container base-image digests and Node
checksums stay pinned when mirrors change. arm64 Chromium explicitly uses the
official source because the mirror lacks its compatible download path. The VM home is
`~/.lima-dsh-phalanx`, or an absolute `DSH_PHALANX_VM_HOME`. Its ownership marker
binds it to this checkout. `down` stops the VM; `destroy` removes that VM and all
its product data, accounts, images and caches. Other Lima instances are untouched.
No real credentials are copied from host environment or ignored checkout files.
An interrupted system upgrade must be recovered with the installer's recovery
command from `shell` before another `up`. Development arm64 artifacts stay local;
formal product releases remain amd64.

## Development mode

Development mode starts a DSH process for each user. It provides no container,
filesystem or network isolation; use it for local development with trusted users.
Linux rootless Podman containers are the user-space isolation boundary.

Build an external DSH checkout beside this repository:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
git -C ../deepseek-harness checkout --detach d743267388641bc76f17c45ce8b4c231aed1d32c
(cd ../deepseek-harness && corepack pnpm install --frozen-lockfile && corepack pnpm build)
export DSH_PHALANX_DSH_ROOT="$(cd ../deepseek-harness && pwd)"
```

DSH uses its own declared package-manager version. Keep its source and dependencies
outside this repository. Configure the platform in Bash (`bash` first when
starting from zsh):

```sh
export DSH_PHALANX_SESSION_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export DSH_PHALANX_RUNTIME_COMMAND="$(command -v node)"
export DSH_PHALANX_RUNTIME_ARGS_JSON="$(node -e "process.stdout.write(JSON.stringify([process.env.DSH_PHALANX_DSH_ROOT + '/apps/cli/lib/bin.js', '--profile', 'web']))")"
export DSH_PHALANX_DATA_ROOT="$(pwd)/.data"
export DSH_PHALANX_HOST=127.0.0.1
export DSH_PHALANX_PORT=3000
export DSH_PHALANX_ALLOWED_MODEL_PROVIDER=deepseek-official
export DSH_PHALANX_ALLOWED_MODEL=deepseek-chat
export DSH_PHALANX_MODEL_UPSTREAM_BASE_URL=https://api.deepseek.com
read -r -s -p 'Default provider API key: ' DSH_PHALANX_MODEL_UPSTREAM_API_KEY
printf '\n'
export DSH_PHALANX_MODEL_UPSTREAM_API_KEY
corepack pnpm dev
```

The key-input command above uses Bash. Set the same environment variables through
your shell or local environment tooling if using another shell. `.env.example`
lists the main settings; the application reads the process environment and does
not automatically load `.env` files. Keep the session secret stable across normal
restarts. The upstream key stays in the platform process, outside user runtimes.

Open <http://localhost:3000/bootstrap>. Read the protected `bootstrap-credential`
file in the data root and use the first whitespace-separated field (the second is an expiry timestamp) to create the first
administrator. It is never printed by the service and is removed after successful
bootstrap. Sign in at `/login`, then create members at `/admin`. Members enter
native DSH at `/app/<spaceId>/`. Registration is disabled; enabling open registration is not
supported.

Use a new data root. Account deletion preserves private files and retires the old user space; reusing the
username creates a new space. Password reset invalidates every old login while retaining the running
instance. Disable/delete stop the instance; enabling requires a new login.
The last enabled administrator is protected from deletion, disablement or demotion.

## Build the DSH instance image

The platform package and the DSH image are separate build outputs. The package
runs the platform service and admin UI on the host; the image supplies the DSH
runtime used by each member's container. The installer downloads the matching
published outputs, so ordinary installation does not require a local image build.

[Containerfile](containers/dsh/Containerfile) builds the official DSH commit
recorded in [runtime-versions.json](runtime-versions.json) without changing its
source. It uses a digest-pinned Node.js/Debian base, compiles DSH with its frozen
lockfile, replaces development dependencies with production dependencies, restores
workspace links and copies the built workspace into the runtime stage. The
workspace tree remains in the image; the clone's Git history is removed.

The runtime includes Node.js, Corepack and DSH's pinned pnpm, Git, curl, Python,
pip, build tools and bubblewrap. These support terminals, plugin installation,
native dependencies and DSH's workspace sandbox. DSH currently uses pnpm 11.28.5
inside the image; the platform checkout uses pnpm 11.19.0. The recipe preloads
DSH's package manager so plugin operations do not first fetch an unspecified
latest version. Platform plugins and shared model configuration are mounted at
runtime, as are each member's persistent home and workspace. Accounts, provider
keys and member files are not built into the image.

### Build an OCI archive

Use a Linux amd64 development host with Docker Engine and Buildx for the build,
and rootless Podman with pasta, subordinate UID/GID mappings and user namespaces
for runtime checks. Use a dedicated non-root validation account and disposable
data. The build needs network access to the base-image registry, Debian packages,
the pinned DSH repository, its dependency registries and the pip download.

Run from this repository's root. Create the builder once, then reuse it for later
builds. This follows the [Candidate workflow](.github/workflows/candidate.yml),
with a local development image name:

```sh
docker buildx create --name dsh-phalanx-dev --driver docker-container
mkdir -p .scratch/dsh-image
docker buildx build --builder dsh-phalanx-dev \
  --platform linux/amd64 --provenance=false --sbom=false \
  --tag localhost/dsh-phalanx-dev:local \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  --output type=oci,dest=.scratch/dsh-image/dsh.oci.tar \
  -f containers/dsh/Containerfile containers/dsh
```

The final `containers/dsh` argument is the build context: it supplies
`install-pip.sh` and `link-workspace-packages.mjs`. A separate local DSH checkout
is not needed for this build. Keep the recipe's DSH revision aligned with
`runtime-versions.json`; overriding it produces a different, unverified runtime.
Pinned inputs do not guarantee that an independent rebuild has the same digest
as a published image.

### Load and check the image

Run the following as the non-root account that will run the container tests.
Rootless Podman storage belongs to that account; loading with `sudo podman` puts
the image in a different store.

```sh
podman load --input .scratch/dsh-image/dsh.oci.tar
export DSH_PHALANX_CONTAINER_IMAGE=localhost/dsh-phalanx-dev:local
podman image inspect "$DSH_PHALANX_CONTAINER_IMAGE"
podman run --rm --network=none --entrypoint sh "$DSH_PHALANX_CONTAINER_IMAGE" -ec '
  node --version
  COREPACK_ENABLE_NETWORK=0 pnpm --version
  git --version
  curl --version
  python3 --version
  pip --version
  make --version
  cc --version
  bwrap --version
'
```

Check that the image reports `linux` / `amd64`, its configured user is `node`,
and the `dsh.revision` label matches `runtime-versions.json`. The platform starts
managed containers with the invoking non-root account's UID/GID and `keep-id`,
so mounted user directories remain writable. A tool-version check alone does
not verify DSH behavior or container isolation.

With this checkout's dependencies and builds prepared as described above,
install the browser used by the tests and run the container recovery check:

```sh
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e tests/community-container-recovery.e2e.ts --maxWorkers=1
```

The Linux host must also have Playwright's browser system dependencies installed.
This check uses a controlled model fixture and tests two user spaces, isolation,
file and session retention, and platform restart recovery. It does not require a
provider key or an external DSH checkout. Additional network and customization
checks are described below. Mac development checks do not establish Linux
rootless behavior.

A self-built image is for development and validation. Formal installation and
upgrades use the platform package and image identified by the same accepted
release manifest; do not replace a release image with a local rebuild.

## Real DSH checks

After the build, the three development-mode acceptance checks use the external
DSH and a deterministic model fixture, with no real provider credential:

```sh
corepack pnpm test:e2e tests/community-onboarding.e2e.ts tests/community-account-lifecycle.e2e.ts tests/community-default-model.e2e.ts --maxWorkers=1
```

For Linux container checks, set `DSH_PHALANX_CONTAINER_IMAGE` to an image built
from the pinned revision, and optionally `DSH_PHALANX_CONTAINER_RUNTIME` to the
Podman executable. [Build the DSH instance image](#build-the-dsh-instance-image) covers construction,
import and initial verification. Container tests
require a dedicated non-root identity and disposable data; use
`tests/community-container-recovery.e2e.ts` to check two users and restart recovery.

Container deployments must supply `DSH_PHALANX_HOST_PUBLIC_ADDRESSES`, a complete
comma-separated public IPv4 inventory including NAT aliases. Missing inventory
closes external proxy access while the default model remains available. Container
native-network checks use `DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES` for that inventory.
Native customization tests additionally need a controlled public HTTPS fixture
through `DSH_PHALANX_E2E_PERSONAL_UPSTREAM`; they exercise personal models and the
unmodified `@aiwayds/dsh-web-search-tavily@0.6.0` plugin. No real credentials belong
in test fixtures or source.

See [architecture](docs/architecture.md) for layers, ownership and verification
rules. The code is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for
attribution and the [trademark statement](TRADEMARKS.md). External dependencies,
including DSH, retain their own licenses and notices.

The image default command is generated from `src/dsh/cli.ts`. After changing that seam, run `node scripts/build-container-command.mjs`; the service build checks the committed recipe for drift.

## Contributions

Use a separate data directory and test account; never commit API keys, host
configuration, certificates or user data. Preserve the pinned external DSH
revision and integrate through its official CLI, configuration, HTTP and
WebSocket interfaces. Read [architecture](docs/architecture.md) and the
[key decisions](docs/architecture.md#key-decisions) before changing a seam or its owner. Include the problem,
user-visible behavior and affected verification in a contribution. Focused
architecture feedback and reproducible reports are especially useful.

Mac supports source development, process-mode checks and the Lima development VM.
Rootless behavior is verified inside Linux. A clean Ubuntu VM is separately required for
installer dependency/retry/reboot claims; an existing development server does
not prove clean installation. The existing `tests/installer-ubuntu.e2e.ts` accepts
an explicitly recorded private VM identity and candidate supply; HTTPS acceptance
uses `tests/https-preview.e2e.ts` with a private access file and trusted device CA.
Those environment-specific tests require their real infrastructure. T1 uses
controlled substitutes; T2 exercises real Linux containers without provider keys.

This is a feedback-oriented, low-touch community project. Contributions are
welcome; there is no support SLA or promised response time.

## Checks, candidates and release promotion

CI runs on pull requests to main, pushes to main and explicit manual reruns.
The GitHub-hosted Ubuntu 24.04 checks use Node 24.21.0, pnpm 11.19.0 and the
frozen lockfile. Documentation checks (`corepack pnpm docs:check`), types, architecture lint, quick behavior tests, service build,
management UI build and controlled public-entry browser HTTP/WebSocket smoke
must all succeed. `ci-required` rejects failure, cancellation and skipped checks.
The browser smoke uses a deterministic runtime substitute. Actual DSH and
rootless isolation are verified separately on Linux.

The native T2 runner requires at least 32 GiB free before starting the build.
This is a conservative admission threshold, not a measured minimum; a 14 GiB
start failed during image construction.

T0 is `check:fast` on the developer host. T1 is the ordinary required CI check.
T2 (`linux-t2.yml`) builds the selected source on native Ubuntu runners: amd64
runs the approved 51-file, 65-case batch plus one named migration case; arm64
builds and runs six installed smoke cases without publishing. Both jobs check two
Unix identities, UID mapping and mutually separate container stores. T3 is the
same full T2 command through `bash scripts/dev/vm.sh test`. T4 owns real provider
keys/accounts, historical amd64 baselines and mainland installation/upgrade.

Every e2e file declares its tier and credential requirements. The real-news
migration is explicitly excluded as T4 only; missing inputs or unexplained skips
in selected T2 cases fail the report gate. T2 runs manually, before each candidate,
and on PRs touching the paths listed in its workflow. The PR T2 result is advisory
and is not part of `ci-required`; candidate publication requires both native jobs
to pass. There is no nightly trigger. Failed runs retain small logs, reports and
container state, never images. Run `node scripts/validation/t2.mjs --list` to see
the exact selection.

Configure and verify `ci-required` as a main merge restriction before a public
release. A green workflow proves its checks; actual merge enforcement depends
on the repository's enabled branch rules and must be checked separately.

### Candidate contract

Dispatch Candidate from main with a full source commit:

```sh
gh workflow run candidate.yml --repo dake6767/dsh-phalanx --ref main -f commit=<full-source-sha>
```

The source must be an ancestor of the dispatch workflow revision. Checks and
builds use that exact source. Publication scripts use the trusted workflow
revision. Candidate identity is the source commit plus workflow run ID; no rc
tag is created in the source repository. The unsupported public candidate
repository, `dake6767/dsh-phalanx-candidates`, names releases by run ID and uses
`run-<id>` tags on its own metadata history. Those tags are not source commits.
The manifest binds the source, run ID, target version, archive hashes and digest.
Historical rc manifests remain verifiable.

The target is Linux amd64. The platform archive includes compiled service and
management UI, production dependencies, runtime assets, licenses, templates and
a bundled Linux Node runtime. Node's download is checked against the SHA256
pinned in `runtime-versions.json`; no Node or pnpm install is needed to run the
extracted `./start` executable. Installation and service setup are separate.
The archive must be extracted with its internal relative dependency symlinks
preserved. It contains no deployment credentials or user data.

The instance image builds the fixed external DSH revision declared in
`runtime-versions.json` using the digest-pinned base and pinned package recipe in
`containers/dsh/Containerfile`. Its runtime user is `node`; user instances run
through rootless Podman. The image name is `ghcr.io/dake6767/dsh-phalanx`.

Each complete candidate prerelease contains:

- `dsh-phalanx-linux-amd64.tar.gz`: platform and bundled Node.
- `dsh-phalanx-dsh-linux-amd64.oci.tar`: controlled instance-image handoff.
- `SHA256SUMS`: exact closed inventory of both archives.
- `manifest.json`: tag, commit, target platform, DSH revision, toolchain, build
  input identities, originating run ID and complete image reference/digest.

Download an exact `run-<id>` prerelease from the candidate repository, then run
`node scripts/release/verify.mjs <download-directory>` from this source checkout.
Set `CANDIDATE_TAG` and `CANDIDATE_SHA` to require the selected identities.
Verification explicitly rejects inconsistent inventories and corrupt bytes;
an Actions artifact download alone is insufficient. Preserve the verified
manifest alongside the installed platform. On Linux, `sha256sum --strict
--check SHA256SUMS` also checks archive bytes before extraction/import.

Validation hosts follow the public download path. To install or upgrade an
explicit unsupported candidate, use the current standalone installer:

```sh
sudo bash install.sh --version run-<id> \
  --dev-release-base-url https://github.com/dake6767/dsh-phalanx-candidates/releases
```

Supply the ordinary deployment options or answer its prompts. The development
source accepts only explicit run IDs and this fixed repository. It verifies the
successful trusted source run, ancestry, source version, manifest, platform
checksum and image digest. Formal installation and Web updates continue to use
the main repository. No maintainer token or registry credential is sent to the
validation host. For offline archive testing, download the four named assets
directly from the same candidate Release, verify them, and use `--bundle-dir`.
Do not relay chunks from a source-repository rc Release or substitute a rebuilt
validation image.

### Permissions and failure recovery

Ordinary checks use a read-only job `GITHUB_TOKEN`. Candidate image publication
alone has packages write. Formal Release has main-repository contents write only
in its publishing job. Candidate assets use a separate GitHub App installed only
on `dsh-phalanx-candidates`, with Contents read/write and default Metadata read.
Configure `CANDIDATE_APP_CLIENT_ID` as a main-repository variable and
`CANDIDATE_APP_PRIVATE_KEY` as a secret directly in GitHub. The pinned official
App-token action requests only candidate-repository Contents write immediately
before publishing and revokes its token at job completion. Do not install the
App on the source repository or grant Actions, Workflows or Administration write.
Secrets are supplied as environment variables only to the publishing command. No
workflow contains validation-host SSH credentials or model keys. Untrusted PR
checks have no publication capability and do not use `pull_request_target`.

Old PR/main checks can be cancelled. Publication for one candidate or formal
version is serialized without cancellation. A candidate release stays draft
until every required asset is uploaded and downloaded bytes match. An image
published before a failed asset upload does not imply a complete candidate.
Retry failed jobs using the successful build's original Actions artifact.
Partial drafts resume matching assets; mismatches fail without replacement.
A complete candidate rerun restores and verifies its original bytes instead
of rebuilding. If original build inputs are unavailable, create a new candidate.
Published assets and source/image tags are never overwritten with other content.

### Formal promotion

Release accepts explicit dispatch only from the default branch. Verify that the repository and GHCR package are public before promotion; the workflow cannot change account-level visibility. Build a new immutable candidate containing the target source version, then complete every check required by `release-policy.json` against that candidate. Use the preceding formal release for upgrade and retained-data acceptance. Privately modified failure fixtures and local source checks supplement, but never replace, installed candidate results.

Final Linux browser tests set `DSH_PHALANX_INSTALL_ROOT` and `DSH_PHALANX_CANDIDATE_SHA` to execute the downloaded platform's public `start` with bundled Node. Native tests verify the imported DSH revision and use the same candidate image. Run development-only tests separately; their mode guards are intentional. Clean Ubuntu, trusted HTTPS, protected real model credentials and physical mount/reboot tests require dedicated recorded environments.

Only after all required checks pass, commit `releases/acceptance/<version>.json` and `<version>.md` on the default branch. The JSON contains `schema: 1`, the numeric `ticket` from release policy, `status: "accepted"`, the candidate tag, full commit SHA, originating successful Candidate `runId`, `platformSha256`, `imageDigest`, `summarySha256` and the policy's `checks`, each marked `passed`. The summary records executed evidence, failures and retests; do not rewrite earlier acceptance records. The source version does not change the pinned upstream DSH's prerelease status.

Run `node scripts/release/promote.mjs <run-id>` from this checkout. It reads the
matching committed acceptance from the default branch, verifies its identities,
and dispatches Release with the run ID, target version and acceptance JSON SHA256.
Release independently rechecks the successful trusted Candidate run, source
ancestry and version, manifest, archive hashes and acceptance summary. It creates `vX.Y.Z` at the accepted commit, copies the exact platform/OCI bytes and aliases the same image digest to `:X.Y.Z`. Candidate `manifest.json` and `SHA256SUMS` remain unchanged; `release.json` records promotion and acceptance identities. The installer accepts the promotion's three acceptance assets in addition to the four candidate assets and uses the original image digest.

Anonymous image visibility is checked before completing the release; anonymous asset downloads and digest pull are checked explicitly. The completed stable release becomes Latest; previews never do. Tags, assets and images are published by the explicit workflow, without depending on its `GITHUB_TOKEN` event starting another workflow. Do not write an accepted record or invoke promotion with any required check incomplete.

After a completed formal release, `node scripts/release/cleanup-candidates.mjs
<version> --yes` removes completed candidate Releases for that version from the
candidate repository. It inspects all candidate manifests before deleting any;
drafts, other versions, source tags, metadata tags and formal Releases remain.

The separate `Candidate rehearsal` workflow takes a successful candidate run ID.
It copies the original bytes to an unsupported candidate-repository test version
`v<version>-rehearsal.<run-id>`, verifies anonymous downloads and removes only the
owned test Release. Its `rehearsal.json` explicitly says `not-accepted`; it never
creates formal acceptance records or mutates source-repository tags. The original
candidate remains available for acceptance and later formal-release cleanup.
