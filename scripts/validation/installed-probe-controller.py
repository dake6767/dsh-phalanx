"""Owner-scoped installed control; no command or deletion path comes from the probe."""
import hashlib,json,os,pathlib,pwd,re,shlex,shutil,stat,subprocess,sys,time,urllib.parse
root=pathlib.Path(sys.argv[1]).resolve(strict=True)
assert os.geteuid()==0
assert root.parent==pathlib.Path('/var/tmp') and re.fullmatch(r'candidate-release-gate-[a-f0-9]{32}',root.name) and not pathlib.Path(sys.argv[1]).is_symlink()
assert root.stat().st_uid==0 and root.stat().st_mode&0o777==0o700
ownerFile=root/'OWNER.json';assert ownerFile.is_file() and not ownerFile.is_symlink() and ownerFile.stat().st_uid==0 and ownerFile.stat().st_mode&0o777==0o600
owner=json.loads((root/'OWNER.json').read_text());assert owner['purpose']=='candidate-release-gate'
prep=json.loads((root/'probe-preparation.json').read_text());work=pathlib.Path(prep['workRoot']);u=pwd.getpwnam('dsh-phalanx')
assert any(r.get('kind')=='user' and r.get('name')==u.pw_name and r.get('uid')==u.pw_uid and r.get('gid')==u.pw_gid and r.get('home')==u.pw_dir for r in owner['resources'])
assert prep['uid']==u.pw_uid and work.is_dir() and not work.is_symlink() and work.stat().st_uid==u.pw_uid and work.stat().st_mode&0o777==0o700
ctx=json.loads((work/'context.json').read_text());current=pathlib.Path(ctx['current']).resolve(strict=True)
assert current==pathlib.Path('/opt/dsh-phalanx/current').resolve(strict=True)
assert json.loads((current/'build-info.json').read_text())['commit']==owner.get('builtSnapshot',owner['source'])
environment=pathlib.Path('/etc/dsh-phalanx/environment');envinfo=environment.lstat()
assert stat.S_ISREG(envinfo.st_mode) and envinfo.st_uid==0 and envinfo.st_gid==u.pw_gid and envinfo.st_mode&0o777==0o640
original=root/'environment-before-projection-controls'
if not original.exists():
 original.write_bytes(environment.read_bytes());original.chmod(0o600)
assert original.is_file() and not original.is_symlink() and original.stat().st_mode&0o777==0o600
base={'HOME':u.pw_dir,'USER':u.pw_name,'LOGNAME':u.pw_name,'LANG':'C.UTF-8','PATH':str(current/'node/bin')+':/usr/bin:/bin','XDG_RUNTIME_DIR':f'/run/user/{u.pw_uid}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{u.pw_uid}/bus'}
def user(args,**kw):return subprocess.run(['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in base.items()],*map(str,args)],cwd=u.pw_dir,capture_output=True,text=True,check=True,**kw)
def values(raw):
 result={}
 for line in raw.splitlines():
  if not line.strip() or line.lstrip().startswith('#'):continue
  key,value=line.split('=',1);parts=shlex.split(value);assert len(parts)==1;result[key]=parts[0]
 return result
def service(action,*names):user(['systemctl','--user',action,*(names or ('dsh-phalanx.service',))])
def stop():
 # PartOf and Requires must settle in one transaction before the next start.
 service('stop','dsh-phalanx.service','dsh-phalanx-postgres.service')
 for unit in ('dsh-phalanx.service','dsh-phalanx-postgres.service'):
  assert user(['systemctl','--user','show',unit,'--property=ActiveState','--value']).stdout.strip() in ('inactive','failed')
 # Keep each controlled restart outside the installed 10 second start-limit window.
 time.sleep(11)
def update(replacements):
 before=environment.read_bytes();lines=before.decode().splitlines();lines=[line for line in lines if line.partition('=')[0] not in replacements]
 lines.extend(key+'='+shlex.quote(value) for key,value in replacements.items() if value is not None)
 temporary=environment.with_name('environment.validation-next');assert not temporary.exists() and not temporary.is_symlink()
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
 with os.fdopen(fd,'w') as output:output.write('\n'.join(lines)+'\n');output.flush();os.fsync(output.fileno())
 os.chown(temporary,0,u.pw_gid);temporary.replace(environment)
 return hashlib.sha256(before).hexdigest(),hashlib.sha256(environment.read_bytes()).hexdigest()
def active():
 import urllib.request
 for _ in range(120):
  try:
   assert all(user(['systemctl','--user','is-active',unit]).stdout.strip()=='active' for unit in ('dsh-phalanx.service','dsh-phalanx-postgres.service'))
   for path in ('/readyz','/admin/api/groups'):
    req=urllib.request.Request(ctx['address']+path,headers={'Host':urllib.parse.urlsplit(ctx['origin']).netloc,'Cookie':ctx['adminCookie']})
    with urllib.request.urlopen(req,timeout=3) as response:
     assert response.status==200
     if path.endswith('/groups'):assert isinstance(__import__('json').load(response),list)
   return
  except Exception:pass
  time.sleep(.5)
 raise RuntimeError('Owned platform and SQL did not become ready')
ledger=[];seen=set()
while not (work/'probe-ended.json').exists():
 request=work/'control-request.json'
 if not request.exists():time.sleep(.25);continue
 info=request.lstat();assert stat.S_ISREG(info.st_mode) and info.st_uid==u.pw_uid and info.st_mode&0o777==0o600
 item=json.loads(request.read_text());identity=item['id'];assert re.fullmatch(r'[a-f0-9-]{36}',identity)
 if identity in seen:time.sleep(.25);continue
 seen.add(identity);request_environment=environment.read_bytes();action=item['action'];row={'id':identity,'action':action,'status':'running','startedAt':time.time()}
 try:
  assert action in ('configure-git','restore-git','configure-catalog','rebuild-projections')
  stop()
  if action=='configure-git':
   assert set(item)=={'id','action','proxy','caFile'}
   proxy=urllib.parse.urlsplit(item['proxy']);assert proxy.scheme=='http' and proxy.hostname=='127.0.0.1' and proxy.port and proxy.username is None and not proxy.query and not proxy.fragment
   ca=pathlib.Path(item['caFile']);assert str(ca).startswith('/tmp/skill-git-fixture-') and ca.name=='cert.pem'
   assert ca.is_file() and not ca.is_symlink() and ca.stat().st_uid==u.pw_uid and ca.parent.stat().st_uid==u.pw_uid
   row['configurationHashes']=update({'HTTPS_PROXY':item['proxy'],'GIT_SSL_CAINFO':str(ca)})
  elif action=='restore-git':
   assert set(item)=={'id','action'}
   prior=values(original.read_text());row['configurationHashes']=update({key:prior.get(key) for key in ('HTTPS_PROXY','GIT_SSL_CAINFO')})
  elif action=='configure-catalog':
   assert set(item)=={'id','action','address'}
   assert item['address']=='https://github.com/dake6767/dsh-phalanx-catalog/releases/download/catalog-40075953922/catalog.json'
   row['configurationHashes']=update({'DSH_PHALANX_SUITE_CATALOG_ADDRESS':item['address']})
  else:
   assert set(item)=={'id','action'}
   data=pathlib.Path(ctx['dataRoot']);assert data==pathlib.Path(values(environment.read_text())['DSH_PHALANX_DATA_ROOT']) and data.resolve()==data
   assert data.is_dir() and not data.is_symlink() and data.stat().st_uid==u.pw_uid
   label=hashlib.sha256(str(data).encode()).hexdigest()
   ids=user(['podman','ps','-aq','--filter','label=dsh-phalanx.community-root='+label]).stdout.split()
   if ids:
    rows=json.loads(user(['podman','inspect',*ids]).stdout)
    assert all(value['Config']['Labels'].get('dsh-phalanx.community-root')==label for value in rows)
    user(['podman','rm','-f',*ids])
   assert not user(['podman','ps','-q','--filter','label=dsh-phalanx.community-root='+label]).stdout.strip()
   module="import{pathToFileURL}from'node:url';const{dataRootLayout}=await import(pathToFileURL(process.argv[1]+'/dist/domain/data-root-layout.js'));console.log(JSON.stringify(dataRootLayout.projections))"
   paths=json.loads(user([current/'node/bin/node','--input-type=module','-e',module,str(current)]).stdout)
   assert len(paths)==6 and set(paths)=={'plugins/instances','skills/members','experts/members','mcp/members','managed-models','platform-plugin'}
   for relative in paths:
    target=data/relative;info=target.lstat();assert target.is_dir() and not target.is_symlink() and target.resolve().is_relative_to(data) and info.st_uid==u.pw_uid
   row['projectionPaths']=paths;row['retainedScopes']=['postgresql','keys','user-data','all-artifacts','platform.lock']
   for relative in paths:shutil.rmtree(data/relative)
   assert all(not (data/relative).exists() for relative in paths)
  service('start');active();row.update(status='passed',finishedAt=time.time())
 except BaseException as error:
  row.update(status='failed',errorType=type(error).__name__,finishedAt=time.time())
  try:
   expected=row.get('configurationHashes',(hashlib.sha256(request_environment).hexdigest(),)*2)
   assert hashlib.sha256(environment.read_bytes()).hexdigest() in expected, 'Unrelated configuration change preserved'
   temporary=environment.with_name('environment.validation-restore');assert not temporary.exists() and not temporary.is_symlink()
   fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
   with os.fdopen(fd,'wb') as output:output.write(request_environment);output.flush();os.fsync(output.fileno())
   os.chown(temporary,0,u.pw_gid);temporary.replace(environment);row['configurationRestored']=True
   stop();service('start');active();row['serviceRestored']=True
  except Exception:row.setdefault('configurationRestored',False);row.setdefault('serviceRestored',False)
 ledger.append(row);(root/'projection-controls.json').write_text(json.dumps(ledger,indent=2)+'\n');(root/'projection-controls.json').chmod(0o600)
 response=work/'control-response.next';response.write_text(json.dumps({'id':identity,'status':row['status']})+'\n');response.chmod(0o600);os.chown(response,u.pw_uid,u.pw_gid);response.replace(work/'control-response.json')
 if row['status']!='passed':raise SystemExit(1)
