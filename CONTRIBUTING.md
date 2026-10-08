# Development and contribution

Start in a new directory with a source checkout:

```sh
git clone https://github.com/dake6767/dsh-phalanx.git
cd dsh-phalanx
```

Use Git, Node.js 24.21.0 and Corepack with pnpm 11.19.0. The external DSH
build also needs its [upstream build prerequisites](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/README.md); the platform does not install developer build tools. Exact dependency versions are
recorded in the manifests and frozen lockfile. `runtime-versions.json` records
the supported external DSH revision: `dsh-v0.2.1-alpha.1`, an upstream prerelease. Quick installer tests also require Python
3.12 or newer. Edit installer sources under `scripts/install/`, then regenerate
the standalone entry with `node scripts/install/build-installer.mjs`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check:fast
```

The fast check runs typechecking, architecture lint, all quick tests, the service
build and the account-management UI build. Generated output lives in `dist/`
and `admin-ui/dist/`.

## Development mode

Development mode starts a DSH process for each user. It provides no container,
filesystem or network isolation; use it for local development with trusted users.
Linux rootless Podman containers are the user-space isolation boundary.

Build an external DSH checkout beside this repository:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
git -C ../deepseek-harness checkout --detach 5badb15009ae1756c3afe0ae0cef1faafc290ccc
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

## Real DSH checks

After the build, the three development-mode acceptance checks use the external
DSH and a deterministic model fixture, with no real provider credential:

```sh
corepack pnpm test:e2e tests/community-onboarding.e2e.ts tests/community-account-lifecycle.e2e.ts tests/community-default-model.e2e.ts --maxWorkers=1
```

For Linux container checks, set `DSH_PHALANX_CONTAINER_IMAGE` to an image built
from the pinned revision, and optionally `DSH_PHALANX_CONTAINER_RUNTIME` to the
Podman executable. `containers/dsh/` contains the image recipe. Container tests
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

Mac supports source development and process-mode checks. Linux is required to
prove rootless container behavior. A clean Ubuntu VM is separately required for
installer dependency/retry/reboot claims; an existing development server does
not prove clean installation. The existing `tests/installer-ubuntu.e2e.ts` accepts
an explicitly recorded private VM identity and candidate supply; HTTPS acceptance
uses `tests/https-preview.e2e.ts` with a private access file and trusted device CA.
Those environment-specific tests require their real infrastructure. Ordinary CI
uses controlled substitutes and does not prove them.

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

Configure and verify `ci-required` as a main merge restriction before a public
release. A green workflow proves its checks; actual merge enforcement depends
on the repository's enabled branch rules and must be checked separately.

### Candidate contract

A maintainer creates a new lightweight `vMAJOR.MINOR.PATCH-rc.N` tag, with positive N, at a
trusted main commit. Candidate checks the exact SHA and reruns CI before any
publication. Do not move or reuse a candidate tag for changed source.

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

Download an exact prerelease using the maintainer's local `gh`, then run
`node scripts/release/verify.mjs <download-directory>` from this source checkout.
Set `CANDIDATE_TAG` and `CANDIDATE_SHA` to require the selected identities.
Verification explicitly rejects inconsistent inventories and corrupt bytes;
an Actions artifact download alone is insufficient. Preserve the verified
manifest alongside the installed platform. On Linux, `sha256sum --strict
--check SHA256SUMS` also checks archive bytes before extraction/import.

Private preview handoff uses the OCI archive over controlled SSH. No maintainer
login token or registry credential is sent to the validation host. Import the
verified archive into the dedicated non-root user's Podman storage, inspect its
digest, labels, platform and user, and configure the platform with that image.
Never substitute an independently rebuilt validation image for the candidate.

### Permissions and failure recovery

All workflows use their job-provided `GITHUB_TOKEN`, exposed to `gh` only as
`GH_TOKEN`. Daily checks have contents read. Candidate image publication alone
has packages write; release asset publication alone has contents write. No
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

Dispatch Release with the accepted candidate tag, originating run ID, target version and acceptance JSON SHA256. It verifies the trusted Candidate run, immutable tag, source version, manifest and acceptance summary. It creates `vX.Y.Z` at the accepted commit, copies the exact platform/OCI bytes and aliases the same image digest to `:X.Y.Z`. Candidate `manifest.json` and `SHA256SUMS` remain unchanged; `release.json` records promotion and acceptance identities. The installer accepts the promotion's three acceptance assets in addition to the four candidate assets and uses the original image digest.

Anonymous image visibility is checked before completing the release; anonymous asset downloads and digest pull are checked explicitly. The completed stable release becomes Latest; previews never do. Tags, assets and images are published by the explicit workflow, without depending on its `GITHUB_TOKEN` event starting another workflow. Do not write an accepted record or invoke promotion with any required check incomplete.
