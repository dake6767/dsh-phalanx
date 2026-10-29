"""Exercise built-in database installation at filesystem/OS ports."""
import contextlib
import io
import json
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import shutil
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/install'))
from installer_database import prepare_builtin_database, database_backup_notice
from installer_host import Host as InstallationHost, InstallError
from installer_progress import Progress

PIN={'version':'17.11','image':'docker.io/library/postgres:17.11-bookworm','digest':'sha256:'+'a'*64}
class Host:
    def __init__(self,root):
        self.root=Path(root);self.calls=[];self.messages=[];self.present=False;self.architecture='arm64'
        self.download_sources={'containerMirror':'https://mirror.example/'}
        self.atomic('/product/build-info.json',json.dumps({'versions':{'postgres':PIN}}))
    def path(self,path):return self.root/str(path).lstrip('/')
    def mkdir(self,path,mode=0o700):
        target=self.path(path);target.mkdir(parents=True,exist_ok=True);target.chmod(mode);return target
    def atomic(self,path,text,mode=0o600):
        self.mkdir(str(Path(path).parent));self.path(path).write_text(text);self.path(path).chmod(mode)
    def run(self,args,**kwargs):self.calls.append(args);return subprocess.CompletedProcess(args,0,'','')
    def user(self,uid,args,**kwargs):
        self.calls.append(args);code=0;out=''
        if args[:3]==['podman','image','exists']:code=0 if self.present else 1
        elif args[:2]==['podman','pull']:self.present=True
        elif args[:3]==['podman','image','inspect']:out=json.dumps([{'Digest':PIN['digest'],'Os':'linux','Architecture':self.architecture}])
        elif 'database-initialize' in args:
            out=json.dumps({'masterKeyPath':str(self.path('/var/lib/dsh-phalanx/keys/master.key')),'fingerprint':'sha256:'+'b'*64,'port':25432})
        return subprocess.CompletedProcess(args,code,out,'')
    def tell(self,text):self.messages.append(text)
class DatabaseInstallation(unittest.TestCase):
    def test_backup_notice_survives_real_progress_redaction(self):
        with tempfile.TemporaryDirectory() as root:
            host=InstallationHost(Path(root));host.progress=Progress(Path(root),persist=False)
            info={'masterKeyPath':'/var/lib/dsh-phalanx/keys/master.key','fingerprint':'sha256:'+'b'*64}
            stream=io.StringIO()
            with contextlib.redirect_stderr(stream):database_backup_notice(host,info)
            self.assertIn(info['masterKeyPath'],stream.getvalue())
            self.assertIn(info['fingerprint'],stream.getvalue())
            self.assertIn('offline backup',stream.getvalue())
    def test_configures_owned_rootless_service_with_digest_verification_and_backup_notice(self):
        with tempfile.TemporaryDirectory() as root:
            host=Host(root);values={'DSH_PHALANX_DATA_ROOT':'/var/lib/dsh-phalanx/data'}
            info=prepare_builtin_database(host,1001,1001,'/product',values,{'platform':'linux/arm64'})
            database_backup_notice(host,info)
            self.assertEqual(values['DSH_PHALANX_DATABASE_CONFIG_FILE'],'/var/lib/dsh-phalanx/keys/database.json')
            self.assertIn(['podman','pull','mirror.example/library/postgres@'+PIN['digest']],host.calls)
            unit=host.path('/var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx-postgres.service').read_text()
            self.assertIn('PartOf=dsh-phalanx.service',unit)
            self.assertIn('127.0.0.1:25432:5432',unit)
            self.assertIn('database-password-file',unit)
            self.assertIn('database-wait',unit)
            self.assertIn('/keys/builtin-database.json',unit)
            self.assertNotIn(' --config-file \"'+str(host.path('/var/lib/dsh-phalanx/keys/database.json'))+'\"',unit)
            self.assertNotIn('POSTGRES_PASSWORD=',unit)
            postgres=host.path('/var/lib/dsh-phalanx/data.durable/postgres')
            self.assertTrue(postgres.is_dir())
            self.assertFalse(host.path('/var/lib/dsh-phalanx/data/postgres').exists())
            self.assertIn(str(postgres)+':/var/lib/postgresql/data',unit)
            (postgres/'retained.txt').write_text('KEEP_DATABASE_CONTENTS')
            shutil.rmtree(host.path('/var/lib/dsh-phalanx/data'))
            self.assertEqual((postgres/'retained.txt').read_text(),'KEEP_DATABASE_CONTENTS')
            self.assertTrue(any('offline backup' in value for value in host.messages))
            self.assertTrue(any('sha256:' in value for value in host.messages))
    def test_database_unit_runtime_and_config_directories_belong_to_the_service_identity(self):
        # pam_env can give systemd's user manager the deployer's runtime and
        # config directories; rootless podman then refuses to start the database container.
        with tempfile.TemporaryDirectory() as root:
            host=Host(root);values={'DSH_PHALANX_DATA_ROOT':'/var/lib/dsh-phalanx/data'}
            prepare_builtin_database(host,1002,1002,'/product',values,{'platform':'linux/arm64'})
            unit=host.path('/var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx-postgres.service').read_text()
            environment={'XDG_RUNTIME_DIR':'/run/user/1001','XDG_CONFIG_HOME':'/home/runner/.config'}
            for line in unit.splitlines():
                if line.startswith('Environment='):
                    for assignment in shlex.split(line.removeprefix('Environment=')):
                        key,value=assignment.split('=',1);environment[key]=value
            self.assertEqual(environment['XDG_RUNTIME_DIR'],'/run/user/1002')
            self.assertEqual(environment['XDG_CONFIG_HOME'],'/var/lib/dsh-phalanx/.config')
    def test_refuses_wrong_architecture_before_service_activation(self):
        with tempfile.TemporaryDirectory() as root:
            host=Host(root);host.architecture='amd64'
            with self.assertRaises(InstallError):prepare_builtin_database(host,1001,1001,'/product',{'DSH_PHALANX_DATA_ROOT':'/var/lib/dsh-phalanx/data'},{'platform':'linux/arm64'})
            self.assertFalse(host.path('/var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx-postgres.service').exists())
if __name__=='__main__':unittest.main()
