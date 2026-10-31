"""The upgrader's quiescence takes the same flock the running platform holds."""
import ast,fcntl,json,os,re,select,signal,subprocess,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,'scripts/install')
from installer_host import InstallError
from installer_upgrade_host import UpgradeHost

HOLD=r"""
import { PlatformLock } from %s
const lock = new PlatformLock(process.argv.at(-1)); process.stdout.write('held\n')
process.stdin.once('data', () => { lock.close(); process.stdout.write('released\n') })
process.stdin.once('end', () => process.exit(0))
"""

class PlatformLockContract(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.data=Path(self.temporary.name)/'data'; self.data.mkdir()
        # quiescent() only resolves host paths; skip the constructor's root-owned directory setup.
        self.upgrade=UpgradeHost.__new__(UpgradeHost); self.upgrade.host=SimpleNamespace(path=lambda value:Path(value),progress=None)
        self.job={'source':{'values':{'DSH_PHALANX_DATA_ROOT':str(self.data)}}}
    def quiescent(self):
        with self.upgrade.quiescent(self.job):return True
    def test_refuses_while_the_platform_holds_its_lock_and_proceeds_after_release(self):
        module=json.dumps(Path('src/adapters/platform-lock.ts').resolve().as_uri())
        holder=subprocess.Popen([*os.environ.get('NODE_TSX','node --import tsx').split(),'--input-type=module','-e',HOLD%module,str(self.data)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(),'held')
            with self.assertRaisesRegex(InstallError,'still holds its writer lock'):self.quiescent()
            holder.stdin.write('release\n'); holder.stdin.flush()
            self.assertEqual(holder.stdout.readline().strip(),'released')
            self.assertTrue(self.quiescent())
        finally:
            holder.kill(); holder.wait()
        self.assertEqual(sorted(p.name for p in self.data.iterdir()),['platform.lock'])
    def test_a_killed_platform_releases_the_lock(self):
        module=json.dumps(Path('src/adapters/platform-lock.ts').resolve().as_uri())
        holder=subprocess.Popen([*os.environ.get('NODE_TSX','node --import tsx').split(),'--input-type=module','-e',HOLD%module,str(self.data)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        self.assertEqual(holder.stdout.readline().strip(),'held')
        holder.kill(); holder.wait()
        self.assertTrue(self.quiescent())
    def test_archive_relay_keeps_the_install_lease_until_an_aborted_tool_actually_exits(self):
        source=Path('src/adapters/postgres-upgrade-tools.ts').read_text()
        relay=ast.literal_eval(re.search(r"const leaseRelay =\s*('.*')",source).group(1))
        fifo=self.data/'release';os.mkfifo(fifo)
        lock=self.data/'install.lock';fd=os.open(lock,os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX)
        tool="import os,signal,sys; channel=os.open(sys.argv[1],os.O_RDWR); signal.signal(signal.SIGTERM,lambda *_:print('abort-received',flush=True)); print('ready',flush=True); os.read(channel,1)"
        holder=subprocess.Popen([sys.executable,'-c',relay,str(fd),sys.executable,'-c',tool,str(fifo)],pass_fds=(fd,),stdout=subprocess.PIPE,text=True)
        os.close(fd)
        release=os.open(fifo,os.O_RDWR)
        try:
            self.assertTrue(select.select([holder.stdout],[],[],10)[0]);self.assertEqual(holder.stdout.readline().strip(),'ready')
            holder.send_signal(signal.SIGTERM)
            self.assertTrue(select.select([holder.stdout],[],[],10)[0],'Relay did not forward cancellation')
            self.assertEqual(holder.stdout.readline().strip(),'abort-received')
            with lock.open('rb') as probe:
                with self.assertRaises(BlockingIOError):fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
            os.write(release,b'x');self.assertEqual(holder.wait(timeout=10),0)
            with lock.open('rb') as probe:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:
            os.write(release,b'x');os.close(release)
            if holder.poll() is None:holder.kill()
            holder.wait();holder.stdout.close()
    def test_a_missing_lock_is_free_and_never_created(self):
        # The upgrader runs as root; a lock file it created would be unopenable by the service account.
        self.assertTrue(self.quiescent())
        self.assertEqual(list(self.data.iterdir()),[])
    def test_an_existing_lock_keeps_its_owner_and_mode(self):
        lock=self.data/'platform.lock'; lock.touch(mode=0o600); before=lock.stat()
        self.assertTrue(self.quiescent())
        after=lock.stat()
        self.assertEqual((after.st_uid,after.st_gid,after.st_mode&0o777),(before.st_uid,before.st_gid,0o600))
    def test_a_symbolic_link_is_refused(self):
        (self.data/'platform.lock').symlink_to(self.data/'elsewhere')
        with self.assertRaisesRegex(InstallError,'symbolic link'):self.quiescent()

unittest.main(verbosity=1)
