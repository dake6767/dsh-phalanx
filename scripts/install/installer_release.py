"""Verified fixed project releases, archive staging and rootless image I/O."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.parse
from installer_host import InstallError  # embedded-host
from installer_config import installed_state  # embedded-config
from installer_compatibility import CANDIDATE, STABLE, validate_contract, candidate_identity, candidate_image_tag  # embedded-compatibility

IMAGE = "ghcr.io/dake6767/dsh-phalanx"
RELEASE_BASE = "https://github.com/dake6767/dsh-phalanx/releases"
CANDIDATE_RELEASE_BASE = "https://github.com/dake6767/dsh-phalanx-candidates/releases"
ASSETS = ("dsh-phalanx-linux-amd64.tar.gz", "dsh-phalanx-dsh-linux-amd64.oci.tar")


def asset_names(manifest):
    architecture = {'linux/amd64': 'amd64', 'linux/arm64': 'arm64'}.get(manifest.get('platform'))
    if architecture is None: raise InstallError('Unsupported artifact platform')
    return (f'dsh-phalanx-linux-{architecture}.tar.gz', f'dsh-phalanx-dsh-linux-{architecture}.oci.tar')


def selected_platform(host):
    return 'linux/arm64' if getattr(host, 'development_arm64', False) else 'linux/amd64'


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024*1024), b""):
            result.update(block)
    return result.hexdigest()



def image_identity(manifest):
    if 'imageIdentity' not in manifest:return None
    value=manifest['imageIdentity']
    if (not isinstance(value,dict) or
            not isinstance(value.get('inputHash'),str) or not re.fullmatch('[a-f0-9]{64}',value['inputHash']) or
            not isinstance(value.get('buildCommit'),str) or not re.fullmatch('[a-f0-9]{40}',value['buildCommit']) or
            value.get('digest')!=manifest['image']['digest'] or value.get('dshRevision')!=manifest['dshRevision']):
        raise InstallError('Invalid independent image identity')
    return value


def verify_manifest(directory, version, archive=True, *, assets=True, platform='linux/amd64'):
    manifest = json.loads((directory / "manifest.json").read_text())
    if not isinstance(manifest,dict):raise InstallError("Invalid release manifest")
    names = asset_names(manifest)
    image = manifest.get("image", {})
    files = manifest.get("files", {})
    if not isinstance(image,dict) or not isinstance(files,dict) or not isinstance(manifest.get("toolchain"),dict):raise InstallError("Invalid release manifest")
    if (not candidate_identity(manifest) or
            manifest.get("platform") != platform or
            not re.fullmatch(r"[a-f0-9]{40}", manifest.get("commit", "")) or
            not re.fullmatch(r"[a-f0-9]{40}", manifest.get("dshRevision", "")) or
            not re.fullmatch(r"[1-9][0-9]*", manifest.get("runId", "")) or
            image.get("name") != IMAGE or image.get("tag") != candidate_image_tag(manifest["tag"]) or
            not re.fullmatch(r"sha256:[a-f0-9]{64}", image.get("digest", "")) or
            image.get("reference") != IMAGE+"@"+image["digest"] or
            set(files) != set(names) or
            any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in files.values()) or
            not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", manifest.get("toolchain", {}).get("node", ""))):
        raise InstallError("Invalid release manifest")
    image_identity(manifest)
    validate_contract(manifest)
    if version != manifest["tag"] and version != "v"+manifest["targetVersion"]:
        raise InstallError("Requested version does not match the manifest")
    expected = "".join(f"{files[name]}  {name}\n" for name in names)
    if (directory / "SHA256SUMS").read_text() != expected:
        raise InstallError("Checksum inventory mismatch")
    for name in (names if archive else names[:1]) if assets else ():
        file = directory / name
        if file.is_symlink() or not file.is_file() or digest(file) != files[name]:
            raise InstallError(f"Checksum mismatch: {name}")
    return manifest


def release_location(args):
    development = getattr(args, 'dev_release_base_url', None)
    if development is not None:
        if development != CANDIDATE_RELEASE_BASE or not re.fullmatch(r'run-[1-9][0-9]*', args.version) or args.bundle_dir is not None:
            raise InstallError('Development release source requires the candidate repository and an explicit run-ID candidate')
        return development
    if args.version.startswith('run-') and args.bundle_dir is None:
        raise InstallError('Run-ID candidates require the explicit development release source')
    return RELEASE_BASE


def metadata(host, url):
    try:
        return host.request(url, max_bytes=262144)
    except (OSError, InstallError) as error:
        raise InstallError('Release metadata unavailable or incomplete: '+url+'. Retry a completed release or check --github-proxy-prefix. '+str(error)) from error


def json_metadata(body):
    try:
        value = json.loads(body)
        if not isinstance(value, dict): raise ValueError()
        return value
    except (ValueError, UnicodeError) as error:
        raise InstallError('Invalid release metadata; check the release asset prefix and retry a completed release') from error


def verify_stable_assets(host, base, manifest, pointer=None):
    release = json_metadata(metadata(host, base+'release.json'))
    acceptance_bytes = metadata(host, base+'acceptance.json')
    acceptance = json_metadata(acceptance_bytes)
    summary = metadata(host, base+'acceptance.md')
    summary_hash = hashlib.sha256(summary).hexdigest()
    policy = manifest.get('acceptancePolicy')
    if policy is None:
        policy = {'0.1.0': {'ticket': 14, 'checks': ['ci', 'linux', 'cleanInstall', 'https', 'dogfood']},
            '0.1.1': {'ticket': 9, 'checks': ['ci', 'linux', 'cleanInstall', 'https', 'models', 'spaces', 'recovery', 'storage', 'upgrade', 'review']}}.get(manifest['targetVersion'])
    expected = {'schema': 1, 'version': manifest['targetVersion'], 'candidate': manifest['tag'], 'candidateRun': manifest['runId'],
        'commit': manifest['commit'], 'files': manifest['files'], 'image': IMAGE+':'+manifest['targetVersion'],
        'imageDigest': manifest['image']['digest'], 'acceptanceSha256': hashlib.sha256(acceptance_bytes).hexdigest(), 'summarySha256': summary_hash}
    accepted = {'schema': 1, 'status': 'accepted', 'candidate': manifest['tag'], 'commit': manifest['commit'], 'runId': manifest['runId'],
        'platformSha256': manifest['files'][ASSETS[0]], 'imageDigest': manifest['image']['digest'], 'summarySha256': summary_hash}
    checks = acceptance.get('checks')
    if (not policy or not isinstance(checks, dict) or acceptance.get('ticket') != policy['ticket'] or
            any(release.get(key) != value for key, value in expected.items()) or
            any(acceptance.get(key) != value for key, value in accepted.items()) or
            any(checks.get(key) != 'passed' for key in policy['checks']) or
            pointer is not None and pointer != release):
        raise InstallError('Release, acceptance and latest pointer identities disagree; select a completed version or retry after publication')


def verify_candidate_assets(host, base, manifest, manifest_bytes):
    proof = json_metadata(metadata(host, base+'candidate.json'))
    expected = {'schema': 1, 'repository': 'dake6767/dsh-phalanx', 'candidate': manifest['tag'], 'runId': manifest['runId'],
        'commit': manifest['commit'], 'targetVersion': manifest['targetVersion'], 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest()}
    workflow = proof.get('workflow')
    if (any(proof.get(key) != value for key, value in expected.items()) or not isinstance(workflow, dict) or
            workflow.get('path') != '.github/workflows/candidate.yml' or workflow.get('ref') != 'refs/heads/main' or
            not isinstance(workflow.get('commit'), str) or not re.fullmatch(r'[a-f0-9]{40}', workflow['commit'])):
        raise InstallError('Candidate publication identity disagrees with its manifest; use a completed candidate with candidate.json')


def select_release(host,args,destination):
    release_base = release_location(args)
    if args.bundle_dir is not None:
        if not CANDIDATE.fullmatch(args.version):raise InstallError('Private archive handoff requires an explicit candidate version')
        return args.bundle_dir,verify_manifest(args.bundle_dir,args.version,assets=False,platform=selected_platform(host)),args.version
    if selected_platform(host) != 'linux/amd64':raise InstallError('Development arm64 requires a local bundle')
    if args.version!='latest' and not STABLE.fullmatch(args.version) and not CANDIDATE.fullmatch(args.version):
        raise InstallError('Specify latest, a stable version, or an explicit candidate tag')
    pointer = json_metadata(metadata(host, release_base+'/latest/download/release.json')) if args.version == 'latest' else None
    version = 'v'+str(pointer.get('version', '')) if pointer is not None else args.version
    if pointer is not None and not STABLE.fullmatch(version):
        raise InstallError('Latest pointer must name a completed stable release; select an explicit stable version')
    base = release_base+'/download/'+version+'/'
    for name in ('manifest.json','SHA256SUMS'):
        (destination/name).write_bytes(metadata(host, base+name))
    manifest=verify_manifest(destination,version,assets=False)
    if STABLE.fullmatch(version):
        verify_stable_assets(host, base, manifest, pointer)
    elif getattr(args, 'dev_release_base_url', None) is not None:
        verify_candidate_assets(host, base, manifest, (destination/'manifest.json').read_bytes())
    else:
        raise InstallError('Online candidates require the explicit development release source')
    state=installed_state(host)
    if state and state['version']==version and (manifest['commit']!=state['commit'] or manifest['image']['digest']!=state['imageDigest'] or manifest['files'][ASSETS[0]]!=state['platformSha256']):
        raise InstallError('Installed manifest and receipt disagree')
    return destination,manifest,version


def acquire(host,args,destination,check_manifest=None):
    directory,manifest,version=select_release(host,args,destination)
    if check_manifest:check_manifest(directory,manifest,version)
    if args.bundle_dir is not None:
        if host.progress:host.progress.emit(message='Verifying release checksums', milestone=True)
        return directory,verify_manifest(directory,version,platform=selected_platform(host))
    state=installed_state(host)
    same=state and state['candidate']==manifest['tag'] and state['commit']==manifest['commit'] and state['imageDigest']==manifest['image']['digest'] and state['platformSha256']==manifest['files'][ASSETS[0]]
    if not same:
        sha=manifest['files'][ASSETS[0]]; cached=host.path('/var/cache/dsh-phalanx/'+sha+'.tar.gz')
        if cached.is_file() and not cached.is_symlink() and digest(cached)==sha:
            shutil.copyfile(cached,directory/ASSETS[0]); host.tell('Reusing checksum-verified platform download.')
        else:
            base=release_location(args)+'/download/'+version+'/'
            (directory/ASSETS[0]).write_bytes(host.request(base+ASSETS[0]))
        if host.progress:host.progress.emit(message='Verifying platform checksum', milestone=True)
        manifest=verify_manifest(directory,version,archive=False)
        cache=host.mkdir('/var/cache/dsh-phalanx',0o700)/(sha+'.tar.gz'); temporary=cache.with_suffix('.next')
        shutil.copyfile(directory/ASSETS[0],temporary); temporary.chmod(0o600); os.replace(temporary,cache)
    return directory,manifest


def supply_image(host, uid, directory, manifest, archive):
    reference = manifest["image"]["reference"]
    present = host.user(uid, ["podman", "image", "exists", reference], check=False)
    if present.returncode == 1:
        if archive:
            host.user(uid, ["podman", "load"], input_file=directory / asset_names(manifest)[1])
            identity=image_identity(manifest)
            label='dsh.input.sha256='+identity['inputHash'] if identity else 'org.opencontainers.image.revision='+manifest['commit']
            ids = host.user(uid, ["podman", "images", "--filter", "label="+label, "--format", "{{.ID}}"]).stdout.splitlines()
            matches = []
            for image_id in set(ids):
                facts = json.loads(host.user(uid, ["podman", "image", "inspect", image_id]).stdout)[0]
                if image_matches(facts,manifest):
                    matches.append(image_id)
            if len(matches) != 1:
                raise InstallError("Archive did not supply exactly one matching candidate image")
            host.user(uid, ["podman", "tag", matches[0], IMAGE+":"+manifest["image"]["tag"]])
        else:
            mirror = getattr(host, 'download_sources', {}).get('ghcrMirror', '')
            address = urllib.parse.urlsplit(mirror)
            transport = address.netloc + address.path + reference.removeprefix('ghcr.io/') if mirror else reference
            try:
                host.user(uid, ["podman", "pull", transport])
            except InstallError as error:
                raise InstallError('GHCR image download failed at '+transport+'. Change the GHCR mirror in Download sources or --ghcr-mirror. '+str(error)) from error
            if mirror:
                # Restore the canonical name after fetching the exact digest;
                # verify_image still checks digest, platform, source and DSH revision.
                host.user(uid, ['podman', 'tag', transport, IMAGE+':'+manifest['image']['tag']])
    elif present.returncode != 0:
        raise InstallError("Cannot inspect rootless image storage")
    return verify_image(host,uid,manifest)


def image_command(image,manifest):
    identity=image_identity(manifest)
    config=image.get('Config') or {};labels=config.get('Labels') or {}
    label_matches=(labels.get('dsh.input.sha256')==identity['inputHash'] if identity else
                   labels.get('org.opencontainers.image.revision')==manifest['commit'])
    if (image.get('Digest')!=manifest['image']['digest'] or image.get('Architecture')!=manifest['platform'].split('/')[1] or
            image.get('Os')!='linux' or config.get('User')!='node' or labels.get('dsh.revision')!=manifest['dshRevision'] or not label_matches):
        raise InstallError('Imported/pulled image identity does not match this platform release')
    command=config.get('Cmd')
    if not isinstance(command,list) or len(command)<2 or not all(isinstance(part,str) and part for part in command):
        raise InstallError('Image does not declare its official runtime command')
    return command


def image_matches(image,manifest):
    try:image_command(image,manifest);return True
    except (InstallError,KeyError,TypeError,AttributeError,IndexError):return False


def verify_image(host,uid,manifest):
    image=json.loads(host.user(uid,['podman','image','inspect',manifest['image']['reference']]).stdout)[0]
    return image_command(image,manifest)


def stage_platform(host, directory, manifest):
    if host.progress:host.progress.emit(message='Staging verified platform', milestone=True)
    sha = manifest["files"][asset_names(manifest)[0]]
    target = f'/opt/dsh-phalanx/releases/{manifest["tag"]}-{sha[:16]}'
    host.mkdir("/opt/dsh-phalanx")
    releases = host.mkdir("/opt/dsh-phalanx/releases")
    if not host.path(target).exists():
        with tempfile.TemporaryDirectory(prefix=".install-", dir=releases) as temporary:
            with tarfile.open(directory / asset_names(manifest)[0], "r:gz") as archive:
                archive.extractall(temporary, filter="data")
            staging = Path(temporary)
            for name in ("start", "node/bin/node", "dist/composition/cli.js", "admin-ui/dist/community.html"):
                if not (staging / name).is_file():
                    raise InstallError("Platform archive lacks required runtime assets")
            build = json.loads((staging / "build-info.json").read_text())
            if build.get("commit") != manifest["commit"] or build.get("platform") != manifest["platform"]:
                raise InstallError("Packaged product identity mismatch")
            node = host.run([str(staging / "node/bin/node"), "--version"]).stdout.strip()
            if node != "v"+manifest["toolchain"]["node"]:
                raise InstallError("Bundled Node identity mismatch")
            (staging / ".artifact-sha256").write_text(sha)
            staging.chmod(0o755)
            os.rename(staging, host.path(target))
    if host.path(target+"/.artifact-sha256").read_text() != sha:
        raise InstallError("Existing release directory has a conflicting identity")
    root = host.path(target)
    for path in (root, *root.rglob("*")):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    # A durable prepared/committed journal must never outlive its release tree.
    paths=(root,*root.rglob('*'))
    for path in paths:
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as file:os.fsync(file.fileno())
    for path in reversed(paths):
        if path.is_dir() and not path.is_symlink():host.sync_directory(path)
    host.sync_directory(releases)
    return target



def release_notes(host,version):
    if not STABLE.fullmatch(version):raise InstallError('Formal release notes require a stable version')
    release = json_metadata(metadata(host, RELEASE_BASE+'/download/'+version+'/release.json'))
    if release.get('version') != version[1:]:raise InstallError('Release notes identity changed')
    body = release.get('releaseNotes', 'Release notes: https://github.com/dake6767/dsh-phalanx/releases/tag/'+version)
    if not isinstance(body,str):raise InstallError('Invalid release notes')
    return body[:32768]
