"""Installed acceptance driver. Inputs are hashed; secret context stays owner-local."""
import hashlib,json,os,pathlib,pwd,re,stat,subprocess,sys,tarfile,time,signal,urllib.request,urllib.parse
P=pathlib.Path
assert os.geteuid()==0
root=P(sys.argv[1]).resolve(strict=True);archive=P(sys.argv[2]).resolve(strict=True);archive_sha=sys.argv[3];harness=sys.argv[4]
assert re.fullmatch('[a-f0-9]{64}',archive_sha) and re.fullmatch('[a-f0-9]{40}',harness)
assert root.parent==pathlib.Path('/var/tmp') and re.fullmatch(r'candidate-release-gate-[a-f0-9]{32}',root.name) and not pathlib.Path(sys.argv[1]).is_symlink()
assert root.stat().st_uid==0 and root.stat().st_mode&0o777==0o700
ownerFile=root/'OWNER.json';assert ownerFile.is_file() and not ownerFile.is_symlink() and ownerFile.stat().st_uid==0 and ownerFile.stat().st_mode&0o777==0o600
owner=json.loads((root/'OWNER.json').read_text());assert owner['purpose']=='candidate-release-gate'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==archive_sha
prep=json.loads((root/'probe-preparation.json').read_text());assert prep['status']=='prepared'
work=P(prep['workRoot']);u=pwd.getpwnam('dsh-phalanx')
assert any(r.get('kind')=='user' and r.get('name')==u.pw_name and r.get('uid')==u.pw_uid and r.get('gid')==u.pw_gid and r.get('home')==u.pw_dir for r in owner['resources'])
assert work.is_dir() and not work.is_symlink() and work.stat().st_uid==u.pw_uid and work.stat().st_mode&0o777==0o700 and prep['uid']==u.pw_uid
context=json.loads((work/'context.json').read_text());current=P(context['current']).resolve(strict=True)
assert current==P('/opt/dsh-phalanx/current').resolve(strict=True) and json.loads((current/'build-info.json').read_text())['commit']==owner.get('builtSnapshot',owner['source'])
assert not (root/'installed-acceptance.json').exists(), 'Preserve previous run; no implicit rerun'
source=work/'source'
env={'HOME':u.pw_dir,'USER':u.pw_name,'LOGNAME':u.pw_name,'PATH':str(current/'node/bin')+':/usr/bin:/bin','XDG_RUNTIME_DIR':f'/run/user/{u.pw_uid}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{u.pw_uid}/bus','LANG':'C.UTF-8','COREPACK_DEFAULT_TO_LATEST':'0','NPM_CONFIG_REGISTRY':'https://registry.npmjs.org','NODE_OPTIONS':'--max-old-space-size=512','DSH_PHALANX_MILESTONE_CONTEXT_FILE':str(work/'context.json')}
def user(args,**kwargs):return subprocess.run(['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in env.items()],*map(str,args)],cwd=source if source.is_dir() else u.pw_dir,**kwargs)
assert os.getpid()==os.getpgrp(), 'The installed probe requires an independent process group'
state={'driverPid':os.getpid(),'driverProcessGroup':os.getpgrp(),'status':'running','builtSource':owner['source'],'harnessSource':harness,'harnessArchiveSha256':archive_sha,'startedAt':time.time(),'stages':[]};controller=None;control_log=None
receipt=root/'installed-acceptance.json'
def save():
 p=receipt.with_suffix('.next');p.write_text(json.dumps(state,indent=2)+'\n');p.chmod(0o600);p.replace(receipt)
def stage(name,args,privileged=False):
 state['stage']=name;save();begin=time.monotonic();p=root/(name+'.log')
 with p.open('x') as log:
  os.fchmod(log.fileno(),0o600)
  result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT) if privileged else user(args,stdout=log,stderr=subprocess.STDOUT)
 row={'stage':name,'status':'passed' if result.returncode==0 else 'failed','exitCode':result.returncode,'seconds':round(time.monotonic()-begin,2),'outputSha256':hashlib.sha256(p.read_bytes()).hexdigest()};state['stages'].append(row);save()
 assert result.returncode==0, 'Owned acceptance stage failed'
def finish_controller():
 global controller,control_log
 if controller is None:
  if control_log is not None:control_log.close();control_log=None
  return
 group=controller.pid;state['controllerProcessGroup']=group;save()
 try:
  ended=work/'probe-ended.json'
  if ended.exists():
   info=ended.lstat();assert stat.S_ISREG(info.st_mode) and info.st_uid==u.pw_uid and info.st_mode&0o777==0o600
  else:
   assert not ended.is_symlink();ended.write_text(json.dumps({'finishedAt':time.time()})+'\n');ended.chmod(0o600);os.chown(ended,u.pw_uid,u.pw_gid)
  def signal_group(sig):
   try:os.killpg(group,sig)
   except ProcessLookupError:pass
  def drained():
   for entry in P('/proc').glob('[0-9]*'):
    try:
     fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
     if int(fields[2])==group and fields[0]!='Z':return False
    except (FileNotFoundError,ProcessLookupError):pass
   return True
  try:code=controller.wait(timeout=15)
  except subprocess.TimeoutExpired:
   signal_group(signal.SIGTERM)
   try:code=controller.wait(timeout=5)
   except subprocess.TimeoutExpired:signal_group(signal.SIGKILL);code=controller.wait(timeout=5)
  for sig in (signal.SIGTERM,signal.SIGKILL):
   if drained():break
   signal_group(sig);deadline=time.monotonic()+5
   while not drained() and time.monotonic()<deadline:time.sleep(.1)
  assert drained(), 'Owned control process group did not drain'
  state['controllerDrained']=True;state['controllerExitCode']=code;controller=None
  assert code==0, 'Projection controller failed'
 finally:
  if control_log is not None:control_log.close();control_log=None
def restore_configuration():
 assert controller is None and state.get('controllerDrained',True), 'Control processes must drain before configuration recovery'
 environment=P('/etc/dsh-phalanx/environment');info=environment.lstat();backup=root/'environment-before-observer'
 assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_gid==u.pw_gid and info.st_mode&0o777==0o640
 assert backup.is_file() and not backup.is_symlink() and backup.stat().st_uid==0 and backup.stat().st_mode&0o777==0o600
 original=backup.read_bytes();assert hashlib.sha256(original).hexdigest()==prep['originalEnvironmentSha256']
 # Only hashes written by this exact preparation/controller may be restored.
 allowed={prep['configuredEnvironmentSha256'],prep['originalEnvironmentSha256']}
 ledger=root/'projection-controls.json'
 if ledger.exists():
  for row in json.loads(ledger.read_text()):allowed.update(row.get('configurationHashes',[]))
 assert hashlib.sha256(environment.read_bytes()).hexdigest() in allowed, 'Unrelated configuration preserved'
 temporary=environment.with_name('environment.validation-final');assert not temporary.exists() and not temporary.is_symlink()
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
 with os.fdopen(fd,'wb') as output:output.write(original);output.flush();os.fsync(output.fileno())
 os.chown(temporary,0,u.pw_gid);temporary.replace(environment);state['configurationRestored']=True
 result=user(['systemctl','--user','stop','dsh-phalanx.service','dsh-phalanx-postgres.service'],capture_output=True);assert result.returncode==0
 time.sleep(11)
 result=user(['systemctl','--user','start','dsh-phalanx.service'],capture_output=True);assert result.returncode==0
 for _ in range(120):
  try:
   for unit in ('dsh-phalanx.service','dsh-phalanx-postgres.service'):
    assert user(['systemctl','--user','is-active',unit],capture_output=True).returncode==0
   for path in ('/readyz','/admin/api/groups'):
    req=urllib.request.Request(context['address']+path,headers={'Host':urllib.parse.urlsplit(context['origin']).netloc,'Cookie':context['adminCookie']})
    with urllib.request.urlopen(req,timeout=3) as response:
     assert response.status==200
     if path.endswith('/groups'):assert isinstance(json.load(response),list)
   break
  except Exception:time.sleep(.5)
 else:raise RuntimeError('Owned restored service and SQL not ready')
 state['serviceRestored']=True
save()
try:
 source=work/'source';assert not source.exists() and not source.is_symlink();source.mkdir(mode=0o700)
 with tarfile.open(archive) as tar:
  assert tar.pax_headers.get('comment')==harness, 'The Harness archive must be the declared commit'
  tar.extractall(source,filter='data')
 for directory,dirs,files in os.walk(source,followlinks=False):
  os.chown(directory,u.pw_uid,u.pw_gid)
  for name in dirs+files:os.chown(P(directory)/name,u.pw_uid,u.pw_gid,follow_symlinks=False)
 stage('harness-dependencies',['corepack','pnpm','install','--frozen-lockfile'])
 control_log=(root/'projection-controller.log').open('x');os.fchmod(control_log.fileno(),0o600)
 controller=subprocess.Popen(['python3',str(root/'probe-controller.py'),str(root)],stdout=control_log,stderr=subprocess.STDOUT,start_new_session=True)
 state['controllerDrained']=False;state['controllerProcessGroup']=controller.pid;save()
 stage('installed-business',['corepack','pnpm','exec','vitest','run','--config','scripts/validation/data-root-installed.config.mjs','--reporter=default','--reporter=json','--outputFile='+str(work/'vitest-report.json')])
 business=json.loads((work/'business-result.json').read_text());assert business['status']=='passed' and business['projectionRebuild'] is True
 state['business']=business;state['businessReportSha256']=hashlib.sha256((work/'vitest-report.json').read_bytes()).hexdigest()
 finish_controller()
 controls=json.loads((root/'projection-controls.json').read_text());assert all(row['status']=='passed' for row in controls) and sum(row['action']=='rebuild-projections' for row in controls)==1
 stage('physical-scan',['python3',str(root/'physical-scan.py'),str(root)],privileged=True)
 scanned=json.loads((root/'scan-result.json').read_text());assert scanned['status']=='passed';state['physicalScan']=scanned;state['status']='passed'
except BaseException as error:state.update(status='failed',errorType=type(error).__name__)
finally:
 try:finish_controller()
 except BaseException as error:state.update(status='failed',controllerErrorType=type(error).__name__)
 try:restore_configuration()
 except BaseException as error:state.update(status='failed',restorationErrorType=type(error).__name__)
 state['finishedAt']=time.time();save()
 print(json.dumps({'status':state['status'],'builtSource':owner['source'],'harnessSource':harness,'receiptSha256':hashlib.sha256(receipt.read_bytes()).hexdigest()}))
if state['status']!='passed':raise SystemExit(1)
