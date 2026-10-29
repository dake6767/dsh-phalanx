"""Owner-scoped preparation of one owner-registered installed acceptance context."""
import hashlib,json,os,pathlib,pwd,re,shlex,stat,subprocess,sys,time
root=pathlib.Path(sys.argv[1]).resolve(strict=True);assert os.geteuid()==0
assert root.parent==pathlib.Path('/var/tmp') and re.fullmatch(r'candidate-release-gate-[a-f0-9]{32}',root.name) and not pathlib.Path(sys.argv[1]).is_symlink()
assert root.stat().st_uid==0 and root.stat().st_mode&0o777==0o700
ownerFile=root/'OWNER.json';assert ownerFile.is_file() and not ownerFile.is_symlink() and ownerFile.stat().st_uid==0 and ownerFile.stat().st_mode&0o777==0o600
owner=json.loads((root/'OWNER.json').read_text());assert owner['purpose']=='candidate-release-gate'
u=pwd.getpwnam('dsh-phalanx')
assert any(r.get('kind')=='user' and r.get('name')==u.pw_name and r.get('uid')==u.pw_uid and r.get('gid')==u.pw_gid and r.get('home')==u.pw_dir for r in owner['resources'])
current=pathlib.Path('/opt/dsh-phalanx/current').resolve(strict=True)
assert json.loads((current/'build-info.json').read_text())['commit']==owner.get('builtSnapshot',owner['source'])
environment=pathlib.Path('/etc/dsh-phalanx/environment');info=environment.lstat()
assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_gid==u.pw_gid and info.st_mode&0o777==0o640
work=pathlib.Path(owner['probeWorkRoot']);assert root.parent==pathlib.Path('/var/tmp') and root.name.startswith('candidate-release-gate-') and work==pathlib.Path(u.pw_dir)/root.name;receipt=root/'probe-preparation.json';backup=root/'environment-before-observer'
prior=json.loads(receipt.read_text()) if receipt.exists() else None
if prior:
 assert prior['status']=='failed' and prior['source']==owner['source'] and prior['uid']==u.pw_uid and prior['workRoot']==str(work)
 assert any(r.get('kind')=='probeDirectory' and r.get('path')==str(work) and r.get('uid')==u.pw_uid for r in owner['resources'])
 assert backup.is_file() and not backup.is_symlink() and hashlib.sha256(backup.read_bytes()).hexdigest()==prior['originalEnvironmentSha256']
 assert hashlib.sha256(environment.read_bytes()).hexdigest()==prior['originalEnvironmentSha256'], 'Unrelated configuration change preserved'
else:
 assert not work.exists() and not work.is_symlink() and not backup.exists()
 backup.write_bytes(environment.read_bytes());backup.chmod(0o600)
 owner['resources'].append({'kind':'probeDirectory','path':str(work),'uid':u.pw_uid,'gid':u.pw_gid})
 (root/'OWNER.json').write_text(json.dumps(owner,indent=2)+'\n');(root/'OWNER.json').chmod(0o600)
original=backup.read_bytes();state={'status':'preparing','source':owner['source'],'workRoot':str(work),'uid':u.pw_uid,'gid':u.pw_gid,'originalEnvironmentSha256':hashlib.sha256(original).hexdigest(),'startedAt':time.time(),'bootstrapAttempted':bool(prior and prior.get('bootstrapAttempted'))}
def save():
 p=receipt.with_suffix('.next');p.write_text(json.dumps(state,indent=2)+'\n');p.chmod(0o600);p.replace(receipt)
def atomic(path,data,uid,gid,mode):
 temporary=path.with_name(path.name+'.validation-next');assert not temporary.exists() and not temporary.is_symlink()
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 with os.fdopen(fd,'wb') as file:file.write(data);file.flush();os.fsync(file.fileno())
 os.chown(temporary,uid,gid);temporary.replace(path)
base={'HOME':u.pw_dir,'PATH':str(current/'node/bin')+':/usr/bin:/bin','XDG_RUNTIME_DIR':f'/run/user/{u.pw_uid}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{u.pw_uid}/bus'}
def user(args,**kwargs):return subprocess.run(['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in base.items()],*map(str,args)],cwd=u.pw_dir,text=True,capture_output=True,check=True,**kwargs)
save()
try:
 if not work.exists():work.mkdir(mode=0o700);os.chown(work,u.pw_uid,u.pw_gid)
 assert work.is_dir() and not work.is_symlink() and work.stat().st_uid==u.pw_uid and work.stat().st_mode&0o777==0o700
 values={}
 for line in original.decode().splitlines():
  if not line.strip() or line.lstrip().startswith('#'):continue
  key,value=line.split('=',1);parts=shlex.split(value);assert len(parts)==1;values[key]=parts[0]
 data=pathlib.Path(values['DSH_PHALANX_DATA_ROOT']);assert data==pathlib.Path(u.pw_dir)/'data'
 assert 'DSH_PHALANX_USER_DATA_ROOT' not in values and 'DSH_PHALANX_USER_DATA_MOUNT' not in values
 users=pathlib.Path(str(data)+'.durable/users');postgres=pathlib.Path(str(data)+'.durable/postgres')
 assert postgres.is_dir() and not postgres.is_symlink()
 assert users.parent.is_dir() and not users.parent.is_symlink() and users.parent.stat().st_uid==u.pw_uid
 assert not users.is_symlink() and (not users.exists() or (users.is_dir() and users.stat().st_uid==u.pw_uid and users.stat().st_mode&0o777==0o700))
 patch=work/'observers.json';content=json.dumps([{'id':'web','config':{'searchProvider':'anysearch'}},{'id':'tools','config':{'mode':'native'}},{'insert':[{'id':'access-probe','name':'/dsh-phalanx/home/access-probe.mjs'},{'id':'execution-observer','name':'/dsh-phalanx/home/observer.mjs'}]}]).encode()+b'\n'
 if patch.exists():assert patch.is_file() and not patch.is_symlink() and patch.stat().st_uid==u.pw_uid and patch.read_bytes()==content
 else:atomic(patch,content,u.pw_uid,u.pw_gid,0o600)
 patches=json.loads(values.get('DSH_PHALANX_RUNTIME_PATCHES_JSON','[]'));assert str(patch) not in patches;patches.append(str(patch))
 lines=[line for line in original.decode().splitlines() if not line.startswith('DSH_PHALANX_RUNTIME_PATCHES_JSON=')]
 lines.append('DSH_PHALANX_RUNTIME_PATCHES_JSON='+shlex.quote(json.dumps(patches,separators=(',',':'))))
 replacement=('\n'.join(lines)+'\n').encode();state.update(phase='observer-configuration',configuredEnvironmentSha256=hashlib.sha256(replacement).hexdigest());save()
 atomic(environment,replacement,info.st_uid,info.st_gid,0o640);user(['systemctl','--user','stop','dsh-phalanx.service','dsh-phalanx-postgres.service']);time.sleep(11);user(['systemctl','--user','start','dsh-phalanx.service'])
 context={'current':str(current),'origin':values['DSH_PHALANX_PUBLIC_ORIGIN'],'address':'http://127.0.0.1:'+values['DSH_PHALANX_PORT'],'gatewayAddress':'http://127.0.0.1:'+values['DSH_PHALANX_CONTAINER_GATEWAY_PORT'],'dataRoot':str(data),'userDataRoot':str(users),'workRoot':str(work),'member':'gate-'+root.name.removeprefix('candidate-release-gate-'),'password':'milestone-member-password'}
 program=r'''import{pathToFileURL}from'node:url';import{request}from'node:http';const i=JSON.parse(process.argv[1]);const{readBootstrapCredential}=await import(pathToFileURL(i.current+'/dist/adapters/bootstrap-credential.js'));const post=(path,form)=>new Promise((resolve,reject)=>{const req=request(i.address+path,{method:'POST',headers:{host:new URL(i.origin).host,origin:i.origin,'content-type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(10000)},async res=>{res.resume();await new Promise(r=>res.on('end',r));resolve(res.statusCode===303?(res.headers['set-cookie']??[]).map(row=>row.split(';')[0]).join('; '):undefined)});req.on('error',reject);req.end(new URLSearchParams(form).toString())});let cookie;for(let n=0;n<60;n++){try{const invitation=readBootstrapCredential(i.dataRoot);if(invitation)cookie=await post('/bootstrap',{credential:invitation.credential,username:'milestone-admin',password:'milestone-admin-password'});if(!cookie&&i.allowExisting)cookie=await post('/login',{username:'milestone-admin',password:'milestone-admin-password'});if(cookie)break}catch{}await new Promise(r=>setTimeout(r,500))}if(!cookie)throw Error('Owned initialization not ready');delete i.allowExisting;console.log(JSON.stringify({...i,adminCookie:cookie}));'''
 # A prior committed initialization whose HTTP response was lost belongs to this exact recorded attempt.
 invitation=data/'bootstrap-credential';assert state['bootstrapAttempted'] or invitation.is_file(), 'A fresh uninitialized owned installation is required'
 state.update(phase='bootstrap',bootstrapAttempted=True);save()
 context=json.loads(user([current/'node/bin/node','--input-type=module','-e',program,json.dumps({**context,'allowExisting':True})],timeout=60).stdout)
 assert users.is_dir() and not users.is_symlink() and users.stat().st_uid==u.pw_uid and users.stat().st_mode&0o777==0o700
 p=work/'context.json';atomic(p,json.dumps(context).encode()+b'\n',u.pw_uid,u.pw_gid,0o600)
 state.update(status='prepared',phase='complete',contextFile=str(p),patchSha256=hashlib.sha256(content).hexdigest(),dataRoot=str(data),userDataRoot=str(users),postgresDataRoot=str(postgres),runtimeOverlayRetained=len(patches)>1,finishedAt=time.time());save()
except BaseException as error:
 state.update(status='failed',errorType=type(error).__name__,finishedAt=time.time())
 try:
  assert hashlib.sha256(environment.read_bytes()).hexdigest() in (state['originalEnvironmentSha256'],state.get('configuredEnvironmentSha256'))
  atomic(environment,original,info.st_uid,info.st_gid,0o640);state['configurationRestored']=True
  user(['systemctl','--user','stop','dsh-phalanx.service','dsh-phalanx-postgres.service']);time.sleep(11);user(['systemctl','--user','start','dsh-phalanx.service']);state['serviceRestored']=True
 except Exception:state.setdefault('configurationRestored',False);state.setdefault('serviceRestored',False)
 save()
print(json.dumps(state))
if state['status']!='prepared':raise SystemExit(1)
