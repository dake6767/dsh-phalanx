# dsh-phalanx

dsh-phalanx hosts DeepSeek Harness (DSH) for small self-hosted teams. Each member
has a private user space with native settings, plugins and model configuration.
A deployer configures a default model once; members can supply their own models.
Administrators manage accounts from one page.

This is a community project, not affiliated with or endorsed by DeepSeek.
Version 0.1.0 is under development. Public installation packages and images
are not available yet. The project welcomes focused feedback and contributions;
maintenance is low-touch, without a promised support response time.

The [Ubuntu installer](docs/install.md) describes the upcoming public download
path and the current explicit candidate validation path.

## Build

Use Node.js 24.21.0 and Corepack with pnpm 11.19.0. Exact dependency versions are
recorded in the manifests and frozen lockfile. `runtime-versions.json` records
the supported external DSH revision. Quick installer tests also require Python
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
git -C ../deepseek-harness checkout --detach 639ed015397290b3745d163aafe02ffee4aa3f84
(cd ../deepseek-harness && corepack pnpm install --frozen-lockfile && corepack pnpm build)
export DSH_PHALANX_DSH_ROOT="$(cd ../deepseek-harness && pwd)"
```

DSH uses its own declared package-manager version. Keep its source and dependencies
outside this repository. Configure the platform in the same shell:

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
file in the data root and use its `credential` value to create the first
administrator. It is never printed by the service and is removed after successful
bootstrap. Sign in at `/login`, then create members at `/admin`. Members enter
native DSH at `/`. Registration is disabled; enabling open registration is not
supported in 0.1.0.

Use a new data root. Account deletion preserves private files and reserves the
username. Password reset invalidates every old login while retaining the running
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
