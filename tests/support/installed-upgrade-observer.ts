import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect } from 'vitest'

export interface InstalledObserverIdentity {
  directory: string
  source: string
}
type Remote = (command: string, timeout?: number, acceptedExitCodes?: number[]) => Promise<string>
/** Reuse the real installed server and peer authentication; the test composition adds observations only. */
export async function installedUpgradeObserver(remote: Remote, source: string, saved?: InstalledObserverIdentity) {
  expect(source).toMatch(/^[a-f0-9]{40}$/u)
  const directory = saved?.directory ?? '/var/tmp/phalanx-upgrade-observer-' + randomUUID()
  expect(directory).toMatch(/^\/var\/tmp\/phalanx-upgrade-observer-[a-f0-9-]{36}$/u)
  if (saved) expect(saved.source).toBe(source)
  const program = await readFile('tests/fixtures/installed-upgrade-observer.py'),
    programSha = createHash('sha256').update(program).digest('hex')
  await remote(`sudo -n python3 - <<'PHALANX_OBSERVER'
import pathlib,os,json,base64,hashlib,subprocess,time,signal,select
root=pathlib.Path(${JSON.stringify(directory)});source=${JSON.stringify(source)};expected=${JSON.stringify(programSha)}
def owned_process():
 pid=owner.get('pid');proc=pathlib.Path('/proc/'+str(pid))
 if not proc.exists():return None
 state=(proc/'stat').read_text().rsplit(')',1)[1].split();assert state[19]==owner['startTicks']
 if state[0]=='Z':return None
 assert (proc/'status').stat().st_uid==0 and (proc/'cmdline').read_bytes().split(b'\\0')[-3:-1]==[str(root/'observer.py').encode(),str(root).encode()]
 assert os.getpgid(pid)==pid
 return pid
if root.exists():
 assert root.is_dir() and not root.is_symlink() and root.stat().st_uid==0 and root.stat().st_mode&0o777==0o700
 owner=json.loads((root/'OWNER.json').read_text());assert owner['source']==source and owner['programSha256']==expected
else:
 root.mkdir(mode=0o700);owner={'source':source,'programSha256':expected};(root/'OWNER.json').write_text(json.dumps(owner));(root/'OWNER.json').chmod(0o600)
assert json.loads(pathlib.Path('/opt/dsh-phalanx/updater/manifest.json').read_text())['sourceCommit']==source
handshake="""import http.client,socket,json
class Client(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(2);self.sock.connect('/run/dsh-phalanx-updater/control.sock')
client=Client('localhost',timeout=2);client.request('POST','/control',body=json.dumps({'action':'status'}),headers={'Content-Type':'application/json'})
response=client.getresponse();assert response.status==200 and isinstance(json.loads(response.read()),dict);client.close()
"""
child=None
try:
 if owned_process() is None:
  subprocess.run(['systemctl','stop','dsh-phalanx-updater.service'],check=True)
  code=base64.b64decode(${JSON.stringify(program.toString('base64'))});assert hashlib.sha256(code).hexdigest()==expected
  script=root/'observer.py';script.write_bytes(code);script.chmod(0o600)
  with (root/'private.log').open('ab') as output:
   os.fchmod(output.fileno(),0o600);child=subprocess.Popen(['python3','-B',str(script),str(root)],cwd='/',stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
  owner['pid']=child.pid;owner['startTicks']=pathlib.Path('/proc/'+str(child.pid)+'/stat').read_text().rsplit(')',1)[1].split()[19];(root/'OWNER.json').write_text(json.dumps(owner));(root/'OWNER.json').chmod(0o600)
 deadline=time.monotonic()+30
 while True:
  assert owned_process() is not None,'Observer exited before control handshake'
  reply=subprocess.run(['runuser','-u','dsh-phalanx','--','python3','-c',handshake],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
  if reply.returncode==0:break
  assert time.monotonic()<deadline,'Observer control handshake failed'
  time.sleep(0.1)
 print('owned observer control handshake passed')
except BaseException:
 # Popen itself proves a still-running child's ownership even if its /proc stat read failed.
 try:
  if child is not None:
   if child.poll() is None:
    assert os.getpgid(child.pid)==child.pid
    os.killpg(child.pid,signal.SIGTERM)
    try:child.wait(timeout=10)
    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  else:
   pid=owned_process()
   if pid is not None:
    descriptor=os.pidfd_open(pid);poll=select.poll();poll.register(descriptor,select.POLLIN);os.killpg(pid,signal.SIGTERM)
    if not poll.poll(10000):os.killpg(pid,signal.SIGKILL);assert poll.poll(10000)
    os.close(descriptor)
 finally:subprocess.run(['systemctl','start','dsh-phalanx-updater.service'],check=True)
 raise
PHALANX_OBSERVER`)
  return {
    identity: { directory, source },
    async finish(passed: boolean) {
      const output = await remote(
        `sudo -n python3 - <<'PHALANX_OBSERVER'
import pathlib,os,json,hashlib,signal,select,subprocess
root=pathlib.Path(${JSON.stringify(directory)});owner=json.loads((root/'OWNER.json').read_text());assert owner['source']==${JSON.stringify(source)} and owner['programSha256']==${JSON.stringify(programSha)}
assert root.is_dir() and not root.is_symlink() and root.stat().st_uid==0
pointer=pathlib.Path('/var/lib/dsh-phalanx-updater/current')
if pointer.exists():
 identity=pointer.read_text().strip();job=json.loads((pointer.parent/identity/'operation.json').read_text())
 assert job['phase'] in ('succeeded','restored','prepare-failed','apply-failed','prepared'), 'Owned executor still has active work; retain observer and diagnostics'
pid=owner['pid'];proc=pathlib.Path('/proc/'+str(pid))
if proc.exists():
 state=(proc/'stat').read_text().rsplit(')',1)[1].split();assert state[19]==owner['startTicks']
 assert (proc/'status').stat().st_uid==0
 if state[0]!='Z':
  assert (proc/'cmdline').read_bytes().split(b'\\0')[-3:-1]==[str(root/'observer.py').encode(),str(root).encode()]
  assert os.getpgid(pid)==pid
  descriptor=os.pidfd_open(pid);poll=select.poll();poll.register(descriptor,select.POLLIN);os.killpg(pid,signal.SIGTERM)
  if not poll.poll(10000):os.killpg(pid,signal.SIGKILL);assert poll.poll(10000)
  os.close(descriptor)
rows=[]
for file in sorted(root.glob('*/observations.json')):
 row=json.loads(file.read_text());rows.append({key:row[key] for key in ('operation','sourceVersion','targetVersion','snapshots','databaseExported','databaseRestoredBeforeStartup','carriersRestoredBeforeStartup','eventWindow') if key in row})
failures=json.loads((root/'observer-failures.json').read_text()) if (root/'observer-failures.json').exists() else []
summary={'observerFailures':failures,'status':'passed' if ${passed ? 'True' : 'False'} and not failures else 'failed','source':owner['source'],'programSha256':owner['programSha256'],'observations':rows}
raw=json.dumps(summary,sort_keys=True)+'\\n';file=root/'summary.json';file.write_text(raw);file.chmod(0o600)
subprocess.run(['systemctl','start','dsh-phalanx-updater.service'],check=True)
print(raw,end='')
PHALANX_OBSERVER`,
        60_000,
      )
      const summary = JSON.parse(output) as {
        observerFailures: unknown[]
        observations: { snapshots: Record<string, unknown>; databaseRestoredBeforeStartup?: boolean; eventWindow?: { decision?: string; exitCode?: number } }[]
      }
      const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
      if (evidence) await writeFile(join(evidence, 'observed-installed-upgrades.json'), output, { mode: 0o600 })
      if (passed) {
        expect(summary.observerFailures).toEqual([])
        expect(summary.observations.some(row => row.databaseRestoredBeforeStartup)).toBe(true)
        expect(summary.observations.some(row => row.snapshots.committed)).toBe(true)
        for (const decision of ['committed', 'restoration-committed'])
          expect(summary.observations.some(row => row.eventWindow?.decision === decision && row.eventWindow.exitCode === 0)).toBe(true)
        // Export precedes owned cleanup, and the caller binds the exact exported bytes.
        if (!evidence) throw Error('Installed upgrade observer requires an evidence directory before cleanup')
        const receiptSha = createHash('sha256').update(output).digest('hex')
        await remote(`sudo -n python3 - <<'PHALANX_OBSERVER'
import pathlib,json,hashlib,shutil
root=pathlib.Path(${JSON.stringify(directory)});owner=json.loads((root/'OWNER.json').read_text());assert owner['source']==${JSON.stringify(source)}
assert root.is_dir() and not root.is_symlink() and root.stat().st_uid==0
assert hashlib.sha256((root/'summary.json').read_bytes()).hexdigest()==${JSON.stringify(receiptSha)}
proc=pathlib.Path('/proc/'+str(owner['pid']))
if proc.exists():assert (proc/'stat').read_text().rsplit(')',1)[1].split()[0]=='Z' and (proc/'stat').read_text().rsplit(')',1)[1].split()[19]==owner['startTicks']
shutil.rmtree(root)
PHALANX_OBSERVER`)
      }
      return summary
    },
  }
}
