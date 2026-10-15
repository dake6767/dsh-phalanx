"""Verified fixed project releases, archive staging and rootless image I/O."""
import hashlib
import base64
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
from installer_host import InstallError  # embedded-host
from installer_config import installed_state  # embedded-config
from installer_compatibility import CANDIDATE, STABLE, validate_contract, candidate_identity, candidate_image_tag  # embedded-compatibility

IMAGE = "ghcr.io/dake6767/dsh-phalanx"
PROJECT_API = "https://api.github.com/repos/dake6767/dsh-phalanx"
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
        return PROJECT_API + '-candidates', development
    if args.version.startswith('run-') and args.bundle_dir is None:
        raise InstallError('Run-ID candidates require the explicit development release source')
    return PROJECT_API, 'https://github.com/dake6767/dsh-phalanx/releases'


def verify_candidate_run(host, manifest):
    run_id = manifest['runId']
    run = json.loads(host.request(PROJECT_API + '/actions/runs/' + run_id))
    workflow = run.get('head_sha', '')
    if (str(run.get('id')) != run_id or run.get('status') != 'completed' or run.get('conclusion') != 'success' or
            run.get('event') != 'workflow_dispatch' or run.get('head_branch') != 'main' or
            run.get('path') != '.github/workflows/candidate.yml' or not re.fullmatch(r'[a-f0-9]{40}', workflow)):
        raise InstallError('Candidate requires a successful trusted source workflow run')
    ancestry = json.loads(host.request(PROJECT_API + '/compare/' + manifest['commit'] + '...' + workflow))
    if ancestry.get('status') not in ('ahead', 'identical'):
        raise InstallError('Candidate source is outside the trusted workflow history')
    package = json.loads(host.request(PROJECT_API + '/contents/package.json?ref=' + manifest['commit']))
    source = json.loads(base64.b64decode(package['content']))
    if source.get('version') != manifest['targetVersion']:
        raise InstallError('Candidate source version differs from its manifest')


def select_release(host,args,destination):
    api, release_base = release_location(args)
    if args.bundle_dir is not None:
        if not CANDIDATE.fullmatch(args.version):raise InstallError('Private archive handoff requires an explicit candidate version')
        return args.bundle_dir,verify_manifest(args.bundle_dir,args.version,assets=False,platform=selected_platform(host)),args.version
    if selected_platform(host) != 'linux/amd64':raise InstallError('Development arm64 requires a local bundle')
    if args.version!='latest' and not STABLE.fullmatch(args.version) and not CANDIDATE.fullmatch(args.version):
        raise InstallError('Specify latest, a stable version, or an explicit candidate tag')
    release=json.loads(host.request(api+'/releases/'+('latest' if args.version=='latest' else 'tags/'+args.version)))
    version=release.get('tag_name','')
    if (not (STABLE.fullmatch(version) or CANDIDATE.fullmatch(version)) or release.get('draft') or
            (STABLE.fullmatch(version) and release.get('prerelease')) or (args.version=='latest' and not STABLE.fullmatch(version))):
        raise InstallError('Latest installation requires a completed stable release')
    if args.version!='latest' and version!=args.version:raise InstallError('Release identity mismatch')
    required={'manifest.json','SHA256SUMS',*ASSETS}
    if STABLE.fullmatch(version):required.update(('acceptance.json','acceptance.md','release.json'))
    if len(release['assets'])!=len(required) or {item['name'] for item in release['assets']}!=required:
        raise InstallError('Release asset inventory is incomplete or unexpected')
    base=release_base+'/download/'+version+'/'
    state=installed_state(host); cached=host.path('/etc/dsh-phalanx/installed-manifest.json')
    if state and state['version']==version and cached.is_file() and not cached.is_symlink():
        manifest=json.loads(cached.read_text())
        if manifest['commit']!=state['commit'] or manifest['image']['digest']!=state['imageDigest'] or manifest['files'][ASSETS[0]]!=state['platformSha256']:
            raise InstallError('Installed manifest and receipt disagree')
        (destination/'manifest.json').write_bytes(cached.read_bytes())
        (destination/'SHA256SUMS').write_text(''.join(f"{manifest['files'][name]}  {name}\n" for name in ASSETS))
    else:
        for name in ('manifest.json','SHA256SUMS'):(destination/name).write_bytes(host.request(base+name))
    manifest=verify_manifest(destination,version,assets=False)
    reference=json.loads(host.request(api+'/git/ref/tags/'+version))['object']
    for _ in range(4):
        if reference['type']=='commit':break
        if reference['type']!='tag':raise InstallError('Release tag must identify a commit')
        reference=json.loads(host.request(api+'/git/tags/'+reference['sha']))['object']
    if getattr(args, 'dev_release_base_url', None) is not None:
        if not release.get('prerelease') or reference['type'] != 'commit' or not re.fullmatch(r'[a-f0-9]{40}', reference.get('sha', '')):
            raise InstallError('Candidate release metadata identity is invalid')
        verify_candidate_run(host, manifest)
    elif reference['type']!='commit' or reference['sha']!=manifest['commit']:
        raise InstallError('Release tag and manifest source commit differ')
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
            base=release_location(args)[1]+'/download/'+version+'/'
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
            ids = host.user(uid, ["podman", "images", "--filter", "label=org.opencontainers.image.revision="+manifest["commit"], "--format", "{{.ID}}"]).stdout.splitlines()
            matches = []
            for image_id in set(ids):
                facts = json.loads(host.user(uid, ["podman", "image", "inspect", image_id]).stdout)[0]
                if facts["Digest"] == manifest["image"]["digest"]:
                    matches.append(image_id)
            if len(matches) != 1:
                raise InstallError("Archive did not supply exactly one matching candidate image")
            host.user(uid, ["podman", "tag", matches[0], IMAGE+":"+manifest["image"]["tag"]])
        else:
            host.user(uid, ["podman", "pull", reference])
    elif present.returncode != 0:
        raise InstallError("Cannot inspect rootless image storage")
    return verify_image(host,uid,manifest)


def verify_image(host,uid,manifest):
    reference=manifest["image"]["reference"]
    image = json.loads(host.user(uid, ["podman", "image", "inspect", reference]).stdout)[0]
    config = image["Config"]
    if (image["Digest"] != manifest["image"]["digest"] or image["Architecture"] != manifest["platform"].split("/")[1] or image["Os"] != "linux" or
            config["User"] != "node" or config["Labels"].get("dsh.revision") != manifest["dshRevision"] or
            config["Labels"].get("org.opencontainers.image.revision") != manifest["commit"]):
        raise InstallError("Imported/pulled image identity does not match this platform release")
    command = config.get("Cmd")
    if not isinstance(command, list) or len(command) < 2 or not all(isinstance(part, str) and part for part in command):
        raise InstallError("Image does not declare its official runtime command")
    return command


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
    release=json.loads(host.request(PROJECT_API+'/releases/tags/'+version))
    if release.get('tag_name')!=version or release.get('draft') or release.get('prerelease'):raise InstallError('Release notes identity changed')
    body=release.get('body') or ''
    if not isinstance(body,str):raise InstallError('Invalid release notes')
    return body[:32768]
