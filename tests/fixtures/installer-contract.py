"""Exercise the installation command with filesystem/OS I/O substitutes."""
import importlib.util
import hashlib
import io
import os
import json
import contextlib
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import urllib.parse
import sys

SOURCE = Path(__file__).resolve().parents[2] / "scripts/install/installer.py"
sys.path.insert(0, str(SOURCE.parent))
spec = importlib.util.spec_from_file_location("community_installer", SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ContractHost(installer.Host):
    def terminal_available(self):
        return False

    def port_conflict(self, address, port, *, allow_managed=False):
        return None


installer.Host = ContractHost

class InstallationMachine:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.calls = []
        self.user = False
        self.active = False
        self.enabled = False
        self.loaded = False
        self.image = None
        self.fail_enable_once = False
        self.port_collision = False
        self.running_target = None
        self.bootstrap_complete = False
        self.mountpoint = None
        (self.root / "etc").mkdir()
        (self.root / "etc/os-release").write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        for name in ("subuid", "subgid"):
            (self.root / "etc" / name).write_text("")
        (self.root / "proc/2000/fd").mkdir(parents=True)
        (self.root / "proc/2000/fd/10").symlink_to("socket:[42]")
        (self.root / "proc/net").mkdir()
        (self.root / "proc/net/tcp").write_text("header\n0: 00000000:46A0 00000000:0000 0A 0 0 0 0 0 42\n")

    def command(self, args, **kwargs):
        self.calls.append(args)
        out = ""
        status = 0
        if args[0] == "getent":
            status = 0 if self.user else 2
            out = "dsh-phalanx:x:1001:1001::/var/lib/dsh-phalanx:/usr/sbin/nologin\n" if self.user else ""
        elif args[0] == 'hostname':
            out = '192.168.1.50\n'
        elif args[0] == 'findmnt':
            out = json.dumps({'filesystems': [{'target': str(self.root / (self.mountpoint or '').lstrip('/'))}]})
        elif args[0] == "useradd":
            self.user = True
        elif args[0] == "usermod":
            table = "subuid" if "--add-subuids" in args else "subgid"
            start, end = args[2].split("-")
            with (self.root / "etc" / table).open("a") as file:
                file.write(f"dsh-phalanx:{start}:{int(end)-int(start)+1}\n")
        elif args[0] == "runuser":
            if kwargs.get("cwd") != (self.root / "var/lib/dsh-phalanx").resolve():
                return subprocess.CompletedProcess(args, 125, "", "Inaccessible deployer working directory")
            nested = args[args.index("--")+1:]
            if nested[0] == "podman":
                if nested[1:3] == ["image", "exists"]:
                    status = 0 if self.image and nested[-1] == "ghcr.io/dake6767/dsh-phalanx@"+self.image["Digest"] else 1
                elif nested[1] == "load":
                    self.image = self.image_facts
                elif nested[1] == "pull":
                    self.image = self.image_facts
                elif nested[1] == "images":
                    out = "d"*64+"\n"
                elif nested[1] == "tag":
                    pass
                elif nested[1:3] == ["image", "inspect"]:
                    out = json.dumps([self.image])
                elif nested[1:3] == ["info", "--format"]:
                    out = json.dumps({"host": {"security": {"rootless": True}, "cgroupVersion": "v2"}})
                else:
                    raise AssertionError(args)
            elif nested[0] == "systemctl":
                if "enable" in nested:
                    self.enabled = True
                elif "disable" in nested:
                    self.enabled = False
                if "is-active" in nested:
                    status = 0 if self.active else 3
                elif "show" in nested:
                    out = "2000\n" if self.active else "0\n"
                elif "daemon-reload" in nested:
                    self.loaded = (self.root / "var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx.service").exists()
                elif "stop" in nested:
                    if not self.loaded:
                        return subprocess.CompletedProcess(args, 5, "", "Unit dsh-phalanx.service not loaded")
                    self.active = False
                    self.running_target = None
                elif "start" in nested or "enable" in nested:
                    if self.fail_enable_once:
                        self.fail_enable_once = False
                        status = 42
                    else:
                        if not self.active:
                            self.running_target = (self.root / "opt/dsh-phalanx/current").readlink()
                        self.active = not self.port_collision
            elif nested[0].endswith('/start') and nested[1] == 'bootstrap-link':
                origin = nested[nested.index('--origin')+1]
                out = origin.rstrip('/') + ('/admin' if self.bootstrap_complete else '/bootstrap#credential='+'i'*43) + '\n'
            else:
                raise AssertionError(args)
        elif args[0].endswith("node"):
            out = "v24.21.0\n"
        elif args[0] not in ("journalctl", "apt-get", "dpkg-query", "chown", "loginctl", "systemctl", "apparmor_parser", "sysctl"):
            raise AssertionError(args)
        return subprocess.CompletedProcess(args, status, out, "")

    def make_bundle(self, tag="v0.1.0-rc.4", commit="a", image_digest="c"):
        bundle = self.root / ("inputs" if tag == "v0.1.0-rc.4" else "inputs-"+tag)
        bundle.mkdir()
        package = bundle / "dsh-phalanx-linux-amd64.tar.gz"
        with tarfile.open(package, "w:gz") as archive:
            files={
                "start": b"#!/bin/sh\nexit 0\n",
                "node/bin/node": b"#!/bin/sh\nprintf 'v24.21.0\\n'\n",
                "dist/composition/cli.js": b"// fixture product entry\n",
                "admin-ui/dist/community.html": b"<p>fixture management UI</p>",
                "build-info.json": json.dumps({"commit": commit*40, "platform": "linux/amd64"}).encode(),
            }
            if tuple(map(int,tag.split('-rc.')[0][1:].split('.')))>(0,1,1):
                directory=SOURCE.parent
                names=json.loads((directory/'executor-files.json').read_text())+['updater.service.in','executor-files.json']
                engine={name:(directory/name).read_bytes() for name in names}
                engine['manifest.json']=json.dumps({'schema':1,'sourceCommit':commit*40,'files':{name:hashlib.sha256(data).hexdigest() for name,data in engine.items()}}).encode()
                files.update({'updater/'+name:data for name,data in engine.items()})
            for name,data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o755 if name in ("start", "node/bin/node") else 0o644
                archive.addfile(member, io.BytesIO(data))
        (bundle / "dsh-phalanx-dsh-linux-amd64.oci.tar").write_bytes(b"independent OCI fixture bytes")
        hashes = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in bundle.iterdir()}
        manifest = {"schema": 1, "tag": tag, "targetVersion": tag.split('-rc.')[0][1:], "commit": commit*40,
                    "runId": "42", "platform": "linux/amd64", "dshRevision": "b"*40,
                    "toolchain": {"node": "24.21.0", "pnpm": "11.19.0"}, "files": hashes,
                    "image": {"name": "ghcr.io/dake6767/dsh-phalanx", "tag": tag[1:], "digest": "sha256:"+image_digest*64,
                              "reference": "ghcr.io/dake6767/dsh-phalanx@sha256:"+image_digest*64}}
        (bundle / "manifest.json").write_text(json.dumps(manifest))
        (bundle / "SHA256SUMS").write_text("".join(f"{hashes[name]}  {name}\n" for name in ("dsh-phalanx-linux-amd64.tar.gz", "dsh-phalanx-dsh-linux-amd64.oci.tar")))
        (self.root / "model-key").write_text("fixture-deployer-key")
        (self.root / "model-key").chmod(0o600)
        self.image_facts = {"Digest": manifest["image"]["digest"], "Architecture": "amd64", "Os": "linux", "Config": {"User": "node", "Cmd": ["node", "/fixture-official-cli.js", "--profile", "web"], "Labels": {
            "dsh.revision": "b"*40, "org.opencontainers.image.revision": commit*40}}}
        return ["--version", tag, "--bundle-dir", str(bundle), "--model-key-file", str(self.root / "model-key"), "--host-public-addresses", "", '--public-origin', 'http://127.0.0.1:18080']


class InstallCommandContract(unittest.TestCase):
    def test_installs_an_explicit_011_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda url, **kwargs: b'login'
            with contextlib.redirect_stdout(output := io.StringIO()):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            self.assertEqual(json.loads(output.getvalue())['candidate'], 'v0.1.1-rc.1')

    def test_legacy_candidate_keeps_key_prompt_loopback_and_legacy_bootstrap(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            for flag in ('--model-key-file', '--public-origin'):
                index = args.index(flag)
                del args[index:index+2]
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            prompts = []
            host.terminal_available = lambda: True
            host.prompt = lambda label, **kwargs: prompts.append((label, kwargs)) or ('y' if label.startswith('Continue') else 'fixture-key')
            host.request = lambda url, **kwargs: b'login'
            with contextlib.redirect_stdout(output := io.StringIO()):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            receipt = json.loads(output.getvalue())
            self.assertEqual(receipt['entry'], 'http://127.0.0.1:18080')
            self.assertNotIn('initializationUrl', receipt)
            self.assertEqual(prompts, [('Model upstream API key: ', {'secret': True}), ('Continue with this configuration? [y/N]: ', {})])
            self.assertFalse(any('bootstrap-link' in call for call in machine.calls))

    def test_candidate_target_version_must_match_before_host_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            path = Path(args[3]) / 'manifest.json'
            manifest = json.loads(path.read_text())
            manifest['targetVersion'] = '0.1.0'
            path.write_text(json.dumps(manifest))
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            self.assertEqual(installer.main([*args, "--output", "json"], host), 1)
            self.assertEqual(machine.calls, [])

    def test_external_user_directory_is_prepared_only_on_the_confirmed_mounted_volume(self):
        for mounted in [False, True]:
            with self.subTest(mounted=mounted), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                (machine.root / 'mnt/data').mkdir(parents=True)
                machine.mountpoint = '/mnt/data' if mounted else None
                args = machine.make_bundle(tag='v0.1.1-rc.1')+['--user-data-root', '/mnt/data/users', '--user-data-mount', '/mnt/data']
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                host.request = lambda url, **kwargs: b'login'
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(installer.main([*args, "--output", "json"], host), 0 if mounted else 1)
                users = machine.root / 'mnt/data/users'
                self.assertEqual(users.exists(), mounted)
                if mounted:
                    self.assertEqual(users.stat().st_mode & 0o777, 0o700)
                    self.assertIn(['chown', '1001:1001', str(users)], machine.calls)
                    config = (machine.root / 'etc/dsh-phalanx/environment').read_text()
                    self.assertIn('DSH_PHALANX_USER_DATA_ROOT="/mnt/data/users"', config)
                    self.assertIn('DSH_PHALANX_USER_DATA_MOUNT="/mnt/data"', config)
                else:
                    self.assertFalse(machine.active)

    def test_receipt_prints_the_initialization_link_without_persisting_its_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda url, **kwargs: b'login'
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            receipt = json.loads(output.getvalue())
            link = urllib.parse.urlparse(receipt['initializationUrl'])
            self.assertEqual(link.path, '/bootstrap')
            self.assertEqual(urllib.parse.parse_qs(link.fragment)['credential'], ['i'*43])
            self.assertNotIn('i'*43, (machine.root / 'etc/dsh-phalanx/install-state.json').read_text())
            machine.bootstrap_complete = True
            with contextlib.redirect_stdout(output := io.StringIO()):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            self.assertNotIn('initializationUrl', json.loads(output.getvalue()))
            self.assertEqual(json.loads(output.getvalue())['adminUrl'], 'http://127.0.0.1:18080/admin')

    def test_deployer_confirms_or_overrides_the_detected_browser_address(self):
        for answer, expected in [('', 'http://192.168.1.50:18080'), ('https://deployment.example.test', 'https://deployment.example.test')]:
            with self.subTest(answer=answer), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = machine.make_bundle(tag='v0.1.1-rc.1')
                index = args.index('--public-origin')
                del args[index:index+2]
                host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
                prompts = []
                host.terminal_available = lambda: True
                answers = iter(['', answer, 'n', 'y'])
                host.prompt = lambda label, **kwargs: prompts.append(label) or next(answers)
                host.request = lambda url, **kwargs: b'login'
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
                self.assertEqual(json.loads(output.getvalue())['entry'], expected)
                self.assertIn('http://192.168.1.50:18080', prompts[1])
                self.assertIn('DSH_PHALANX_HOST="0.0.0.0"', (machine.root / 'etc/dsh-phalanx/environment').read_text())

    def test_installation_needs_no_model_key_when_the_access_address_is_supplied(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle(tag='v0.1.1-rc.1')
            index = args.index('--model-key-file')
            del args[index:index+2]
            args += ['--listen-address', '0.0.0.0', '--public-origin', 'http://192.0.2.10:18080']
            host = installer.Host(machine.root, machine.command, system='Linux', machine='x86_64', uid=0)
            host.request = lambda url, **kwargs: b'login'
            host.prompt = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('Unexpected installation prompt'))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            config = (machine.root / 'etc/dsh-phalanx/environment').read_text()
            self.assertNotIn('DSH_PHALANX_MODEL_UPSTREAM_API_KEY', config)
            self.assertTrue(machine.active)

    def test_unsupported_host_fails_before_changing_the_machine(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            host = installer.Host(Path(directory), lambda *args, **kw: calls.append(args),
                                  system="Linux", machine="aarch64", uid=0)
            self.assertEqual(installer.main([], host), 1)
            self.assertEqual(calls, [])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_corrupt_candidate_fails_before_dependency_or_service_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            (machine.root / "inputs/dsh-phalanx-linux-amd64.tar.gz").write_bytes(b"corrupt")
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            self.assertEqual(installer.main([*args, "--output", "json"], host), 1)
            self.assertEqual(machine.calls, [])
            self.assertFalse((machine.root / "etc/dsh-phalanx").exists())

    def test_overlapping_existing_subordinate_ids_are_rejected_before_starting_podman(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            machine.user = True
            (machine.root / "etc/subuid").write_text("dsh-phalanx:100000:65536\nother:120000:65536\n")
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.request = lambda url, **kwargs: b"login"
            self.assertEqual(installer.main([*args, "--output", "json"], host), 1)
            self.assertFalse(any(cmd[0] == "runuser" for cmd in machine.calls))
            self.assertFalse(machine.active)

    def test_verified_candidate_installs_an_owned_rootless_service_and_private_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.request = lambda url, **kwargs: b"<p>login</p>" if machine.active else (_ for _ in ()).throw(OSError("not ready"))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            self.assertTrue(machine.active)
            self.assertTrue(machine.user)
            receipt = json.loads(output.getvalue())
            self.assertEqual(receipt["imageDigest"], "sha256:"+"c"*64)
            self.assertEqual(receipt["serviceUser"], "dsh-phalanx")
            self.assertNotIn("fixture-deployer-key", output.getvalue())
            self.assertNotIn("fixture-deployer-key", str(machine.calls))
            config = machine.root / "etc/dsh-phalanx/environment"
            self.assertEqual(config.stat().st_mode & 0o777, 0o640)

    def test_explicit_gateway_port_is_preserved_and_cannot_be_silently_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()+["--gateway-port", "41081"]
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.request = lambda url, **kwargs: b"login"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            config = machine.root / "etc/dsh-phalanx/environment"
            original = config.read_bytes()
            self.assertIn(b'DSH_PHALANX_CONTAINER_GATEWAY_PORT="41081"', original)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(installer.main([*args, "--output", "json"][:-3]+["41082"], host), 1)
            self.assertEqual(config.read_bytes(), original)
            self.assertTrue(machine.active)

    def test_image_inheriting_only_node_does_not_count_as_an_official_dsh_command(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            machine.image_facts["Config"]["Cmd"] = ["node"]
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.request = lambda url, **kwargs: b"login"
            self.assertEqual(installer.main([*args, "--output", "json"], host), 1)
            self.assertFalse(machine.enabled)
            self.assertFalse((machine.root / "etc/dsh-phalanx/environment").exists())

    def test_private_umask_still_allows_the_service_to_read_its_platform_and_unit_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.request = lambda url, **kwargs: b"login"
            previous = os.umask(0o077)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            finally:
                os.umask(previous)
            self.assertEqual((machine.root / "opt/dsh-phalanx").stat().st_mode & 0o777, 0o755)
            self.assertEqual((machine.root / "opt/dsh-phalanx/releases").stat().st_mode & 0o777, 0o755)
            self.assertIn(["chown", "-R", "1001:1001", str(machine.root / "var/lib/dsh-phalanx/.config/systemd")], machine.calls)
            release = (machine.root / "opt/dsh-phalanx/current").resolve()
            for directory in ("node", "node/bin", "dist", "dist/composition", "admin-ui/dist"):
                self.assertEqual((release / directory).stat().st_mode & 0o777, 0o755)

    def test_https_public_origin_checks_the_managed_local_socket_with_its_public_host(self):
        for origin, authority in (("https://deployment.example.test:18443", "deployment.example.test:18443"),
                                  ("https://DEPLOYMENT.example.test:443", "deployment.example.test"),
                                  ("http://[0:0:0:0:0:0:0:1]:80", "[::1]")):
            with self.subTest(origin=origin), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = machine.make_bundle()+["--listen-address", "0.0.0.0", "--public-origin", origin]
                host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
                requests = []
                host.request = lambda url, **kwargs: requests.append((url, kwargs)) or b"login"
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
                self.assertEqual(json.loads(output.getvalue())["entry"], origin)
                self.assertEqual(requests, [("http://127.0.0.1:18080/login", {"authority": authority})])

    def test_success_receipt_points_to_the_address_actually_checked_for_readiness(self):
        for address, entry in (("::1", "http://[::1]:18080"), ("::", "http://[::1]:18080"),
                               ("192.0.2.10", "http://192.0.2.10:18080"), ("0.0.0.0", "http://127.0.0.1:18080")):
            with self.subTest(address=address), tempfile.TemporaryDirectory() as directory:
                machine = InstallationMachine(directory)
                args = machine.make_bundle()+["--listen-address", address, '--public-origin', entry]
                (machine.root / "proc/net/tcp6").write_text("header\n0: "+"0"*32+":46A0 "+"0"*32+":0000 0A 0 0 0 0 0 42\n")
                host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
                requests = []
                host.request = lambda url, **kwargs: requests.append(url) or b"login"
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
                self.assertEqual(json.loads(output.getvalue())["entry"], entry)
                self.assertEqual(requests, [entry+"/login"])

    def test_legacy_release_without_recovery_protocol_is_rejected_before_switching(self):
        with tempfile.TemporaryDirectory() as directory:
            machine=InstallationMachine(directory); args=machine.make_bundle()
            host=installer.Host(machine.root,machine.command,system='Linux',machine='x86_64',uid=0)
            host.request=lambda *args,**kwargs:b'login'
            with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(installer.main(args,host),0)
            target=machine.running_target; config=(machine.root/'etc/dsh-phalanx/environment').read_bytes()
            upgrade=machine.make_bundle('v0.1.0-rc.5','d','e')+['--yes','--output','json']
            stop_count=sum('stop' in command for command in machine.calls)
            with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(installer.main(upgrade,host),1)
            self.assertEqual(machine.running_target,target); self.assertTrue(machine.active)
            self.assertEqual((machine.root/'etc/dsh-phalanx/environment').read_bytes(),config)
            self.assertEqual(sum('stop' in command for command in machine.calls),stop_count)

    def test_first_activation_failure_stops_the_unready_service_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.clock = iter([0, 100]).__next__
            host.request = lambda url, **kwargs: (_ for _ in ()).throw(OSError("injected unavailable entry"))
            self.assertEqual(installer.main([*args, "--output", "json"], host), 1)
            self.assertFalse(machine.active)
            self.assertFalse(machine.enabled)
            self.assertFalse((machine.root / "opt/dsh-phalanx/current").is_symlink())
            host.request = lambda url, **kwargs: b"login"
            host.clock = installer.time.monotonic
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main([*args, "--output", "json"], host), 0)
            self.assertTrue(machine.active)

    def test_an_unrelated_http_listener_cannot_make_a_failed_platform_installation_succeed(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            machine.port_collision = True
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.clock = iter([0, 100]).__next__
            host.request = lambda url, **kwargs: b"unrelated successful login page"
            self.assertEqual(installer.main([*args, "--output", "json"], host), 1)
            self.assertFalse(machine.active)
            self.assertFalse(machine.enabled)

    def test_latest_uses_one_completed_stable_release_and_pulls_its_exact_digest_without_login(self):
        with tempfile.TemporaryDirectory() as directory:
            machine = InstallationMachine(directory)
            args = machine.make_bundle()
            bundle = machine.root / "inputs"
            release = {"tag_name": "v0.1.0", "draft": False, "prerelease": False,
                       "assets": [{"name": name} for name in ("manifest.json", "SHA256SUMS", "dsh-phalanx-linux-amd64.tar.gz", "dsh-phalanx-dsh-linux-amd64.oci.tar", "acceptance.json", "acceptance.md", "release.json")]}
            urls = []
            def http(url, **kwargs):
                urls.append(url)
                if url.endswith("/releases/latest"):
                    return json.dumps(release).encode()
                if url.endswith("/git/ref/tags/v0.1.0"):
                    return json.dumps({"object": {"type": "commit", "sha": "a"*40}}).encode()
                if "/releases/download/v0.1.0/" in url:
                    return (bundle / url.rsplit("/", 1)[1]).read_bytes()
                if url.startswith("http://127.0.0.1:"):
                    return b"login"
                raise AssertionError(url)
            host = installer.Host(machine.root, machine.command, system="Linux", machine="x86_64", uid=0)
            host.request = http
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(installer.main(["--version", "latest", *args[4:], "--output", "json"], host), 0)
            receipt = json.loads(output.getvalue())
            self.assertEqual(receipt["version"], "v0.1.0")
            self.assertEqual(receipt["candidate"], "v0.1.0-rc.4")
            nested = [cmd[cmd.index("--")+1:] for cmd in machine.calls if cmd[0] == "runuser"]
            self.assertIn(["podman", "pull", "ghcr.io/dake6767/dsh-phalanx@sha256:"+"c"*64], nested)
            self.assertFalse(any("login" in cmd for cmd in nested))
            self.assertFalse(any(".oci.tar" in url for url in urls))
            release["prerelease"] = True
            before = (machine.root / "etc/dsh-phalanx/environment").read_bytes()
            self.assertEqual(installer.main(["--version", "latest", *args[4:], "--output", "json"], host), 1)
            self.assertEqual((machine.root / "etc/dsh-phalanx/environment").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
