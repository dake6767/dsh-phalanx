# Checks, candidates and release promotion

CI runs on pull requests to main, pushes to main and explicit manual reruns.
The GitHub-hosted Ubuntu 24.04 checks use Node 24.21.0, pnpm 11.19.0 and the
frozen lockfile. Types, architecture lint, quick behavior tests, service build,
management UI build and controlled public-entry browser HTTP/WebSocket smoke
must all succeed. `ci-required` rejects failure, cancellation and skipped checks.
The browser smoke uses a deterministic runtime substitute. Actual DSH and
rootless isolation are verified separately on Linux.

The private preview repository currently cannot enable branch protection with
its account plan. The required status is reported, but GitHub does not enforce
it as a merge restriction. Enable and verify main protection before public
release. Do not infer an enabled rule from a green workflow.

## Candidate contract

A maintainer creates a new lightweight `v0.1.0-rc.N` tag, with positive N, at a
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

## Permissions and failure recovery

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

## Formal promotion

Release accepts explicit dispatch only from the default branch. Before invoking
it, make the repository and GHCR package public using the maintainer's account
and verify their actual visibility. The workflow is intentionally unable to
change account-level visibility. Formal version 0.1.0 is reserved for completed
release acceptance; this preview does not execute that publication.

Commit `releases/acceptance/0.1.0.json` and `0.1.0.md` on the default branch after
the final checks and dogfood. The JSON contract is:

```json
{
  "schema": 1,
  "ticket": 14,
  "status": "accepted",
  "candidate": "v0.1.0-rc.N",
  "commit": "40-character candidate SHA",
  "runId": "successful Candidate run ID",
  "platformSha256": "accepted platform archive SHA256",
  "imageDigest": "sha256:accepted-image-digest",
  "summarySha256": "SHA256 of 0.1.0.md",
  "checks": {
    "ci": "passed", "linux": "passed", "cleanInstall": "passed",
    "https": "passed", "dogfood": "passed"
  }
}
```

Dispatch Release with candidate tag, originating successful run ID, version
`0.1.0` and the JSON file SHA256. The workflow verifies the trusted Candidate
run, immutable tag, source version, manifest and acceptance summary. It creates
`v0.1.0` at the accepted commit, copies the exact platform/OCI bytes and aliases
the same image digest to `:0.1.0`. Candidate manifest and SHA256SUMS remain
unchanged; `release.json` records the promotion and acceptance identities.
Anonymous image visibility is checked before completing the formal release;
anonymous asset downloads and digest pull are then checked explicitly.
The completed stable release becomes Latest; previews never do. The installer
accepts the stable promotion's three acceptance assets in addition to the four
candidate assets and continues to use the original manifest's digest.

Tags, assets and image publication happen in this explicit workflow. No step
depends on its own `GITHUB_TOKEN` event triggering another workflow.
