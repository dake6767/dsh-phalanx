# Checks, candidates and release promotion

CI runs on pull requests to main, pushes to main and explicit manual reruns.
The GitHub-hosted Ubuntu 24.04 checks use Node 24.21.0, pnpm 11.19.0 and the
frozen lockfile. Types, architecture lint, quick behavior tests, service build,
management UI build and controlled public-entry browser HTTP/WebSocket smoke
must all succeed. `ci-required` rejects failure, cancellation and skipped checks.
The browser smoke uses a deterministic runtime substitute. Actual DSH and
rootless isolation are verified separately on Linux.

Configure and verify `ci-required` as a main merge restriction before a public
release. A green workflow proves its checks; actual merge enforcement depends
on the repository's enabled branch rules and must be checked separately.

## Candidate contract

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
release acceptance.

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

## 0.1.1 acceptance

Version 0.1.1 uses the same immutable candidate-to-release path. Record
`releases/acceptance/0.1.1.json` and `0.1.1.md` only after final integration.
Its record uses ticket `9` and requires all of `ci`, `linux`, `cleanInstall`,
`https`, `models`, `spaces`, `recovery`, `storage`, `upgrade`, and `review` to be
`passed`. Candidate SHA, run, platform hash, image digest and summary hash must
match exactly. The 0.1.0 ticket 14 and dogfood checks remain required for 0.1.0;
its independent acceptance and preview are not replaced by 0.1.1 results.
Dispatch with version `0.1.1`, the accepted `v0.1.1-rc.N` and record hash.
The pinned external DSH remains the prerelease v0.2.1-alpha.1; the community
version does not change its upstream release status.

Final Linux browser tests set `DSH_PHALANX_INSTALL_ROOT` and
`DSH_PHALANX_CANDIDATE_SHA` to execute the downloaded platform's public `start`
with bundled Node. Native tests verify the imported DSH revision and use the
same candidate image. Run development-only browser tests separately with the
pinned external DSH; their mode guards are intentional. Clean Ubuntu installer,
trusted HTTPS, protected real model credentials and physical mount/reboot tests
need dedicated recorded environments and cannot be inferred from CI smoke.

## 0.1.3 delivery preparation

Version 0.1.3 retains the immutable candidate and explicit promotion contract.
The final candidate must contain the 0.1.3 source version. Its acceptance record
uses ticket `8` and the checks in `release-policy.json`; every required check
must pass against the same recorded source and candidate asset identities.
Record formal 0.1.2 as the source for both CLI and Web upgrade acceptance.
Local source checks and privately modified failure fixtures supplement this
record; they cannot substitute for the actual installed candidate.

Do not write an accepted record or invoke formal promotion while a required
check remains incomplete. Source preparation and version notes alone do not
mean that 0.1.3 is a completed stable release. The installer continues to select
the latest completed stable release until explicit promotion completes.
