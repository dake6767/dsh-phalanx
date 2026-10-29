"""Freeze and scan the still-populated installed roots; never export secret inputs."""
import pathlib,json,os,pwd,subprocess,hashlib,base64,stat,time,shlex,sys,re
from pathlib import Path
from secret_scan_files import secret_needles,scan_secret_file,runtime_projection_target
assert os.geteuid()==0
assert sys.argv[2:]==[]
root=Path(sys.argv[1]).resolve(strict=True);scanReceipt=root/'scan-result.json';assert not scanReceipt.exists() and not scanReceipt.is_symlink();assert root.parent==pathlib.Path('/var/tmp') and re.fullmatch(r'candidate-release-gate-[a-f0-9]{32}',root.name) and not pathlib.Path(sys.argv[1]).is_symlink()
assert root.stat().st_uid==0 and root.stat().st_mode&0o777==0o700
ownerFile=root/'OWNER.json';assert ownerFile.is_file() and not ownerFile.is_symlink() and ownerFile.stat().st_uid==0 and ownerFile.stat().st_mode&0o777==0o600
owner=json.loads((root/'OWNER.json').read_text());assert owner['purpose']=='candidate-release-gate'
prep=json.loads((root/'probe-preparation.json').read_text());work=Path(prep['workRoot']);u=pwd.getpwnam('dsh-phalanx');assert u.pw_uid==prep['uid'] and work.stat().st_uid==u.pw_uid and work.stat().st_mode&0o777==0o700
assert any(r.get('kind')=='user' and r.get('name')==u.pw_name and r.get('uid')==u.pw_uid and r.get('gid')==u.pw_gid and r.get('home')==u.pw_dir for r in owner['resources'])
business=json.loads((work/'business-result.json').read_text());assert business['status']=='passed' and business['projectionRebuild'] is True
context=json.loads((work/'context.json').read_text());payload=json.loads((work/'scan-input.json').read_text());assert len(payload['knownSecrets'])==len(payload['scopes']) and len(payload['knownSecrets'])>=10 and all(isinstance(v,str) and len(v)>=16 for v in payload['knownSecrets'])
current=Path(context['current']);data=Path(context['dataRoot']);users=Path(context['userDataRoot']);assert data==Path(u.pw_dir)/'data' and users==Path(str(data)+'.durable/users')
postgres=Path(prep['postgresDataRoot']);assert postgres==Path(str(data)+'.durable/postgres') and postgres.is_dir() and not postgres.is_symlink()
assert not any(work.resolve().is_relative_to(p.resolve()) for p in (data,users,postgres))
assert current==Path('/opt/dsh-phalanx/current').resolve()
assert json.loads((current/'build-info.json').read_text())['commit']==owner.get('builtSnapshot',owner['source'])
env={'HOME':u.pw_dir,'PATH':str(current/'node/bin')+':/usr/bin:/bin','XDG_RUNTIME_DIR':'/run/user/'+str(u.pw_uid),'DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/'+str(u.pw_uid)+'/bus'}
def user(args,**kwargs):return subprocess.run(['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in env.items()],*map(str,args)],text=True,capture_output=True,check=True,cwd='/',**kwargs)
def unit_state(unit):return user(['systemctl','--user','show',unit,'--property=ActiveState','--value']).stdout.strip()
record={'status':'running','startedAt':time.time(),'scopes':['rebuildable-platform-data','actual-postgresql-data-and-wal','environment','actual-member-projections-and-user-data'],'businessBeforeScan':True};stopped=False
try:
 pg=json.loads(user(['podman','inspect','dsh-phalanx-postgres']).stdout);assert len(pg)==1 and pg[0]['Config']['Labels'].get('dsh.phalanx.database')=='builtin'
 assert any(Path(row['Source'])==postgres and row['Destination']=='/var/lib/postgresql/data' for row in pg[0]['Mounts'])
 record['actualPostgresqlDataRootVerified']=True
 master=Path(u.pw_dir)/'keys/master.key';masterBytes=master.read_bytes();assert len(masterBytes)==32 and master.stat().st_mode&0o777==0o600
 # Rootless carrier configuration and all product-user processes must not receive the master.
 ids=user(['podman','ps','-aq']).stdout.split();inspections=user(['podman','inspect',*ids]).stdout.encode() if ids else b''
 assert masterBytes not in inspections and base64.b64encode(masterBytes) not in inspections and masterBytes.hex().encode() not in inspections
 checkedProcesses=0
 for path in Path('/proc').glob('[0-9]*'):
  try:
   if path.stat().st_uid!=u.pw_uid:continue
   checkedProcesses+=1
   for name in ('environ','cmdline'):
    content=(path/name).read_bytes();assert masterBytes not in content and base64.b64encode(masterBytes) not in content and masterBytes.hex().encode() not in content
  except (FileNotFoundError,ProcessLookupError,PermissionError):pass
 record['masterNotInRuntime']={'productProcesses':checkedProcesses,'carrierConfigurations':len(ids)}
 user(['systemctl','--user','stop','dsh-phalanx.service','dsh-phalanx-postgres.service']);stopped=True
 time.sleep(11)
 assert unit_state('dsh-phalanx.service') in ('inactive','failed')
 user(['systemctl','--user','start','dsh-phalanx-postgres.service'])
 user([current/'start','database-wait','--config-file',Path(u.pw_dir)/'keys/database.json','--data-root',data])
 program=r'''import{pathToFileURL}from'node:url';import{readFileSync}from'node:fs';const i=JSON.parse(readFileSync(0,'utf8'));const mod=p=>import(pathToFileURL(i.current+'/dist/'+p+'.js'));const{FilePlatformDatabaseConfig:C}=await mod('adapters/platform-database-config');const{PlatformDatabase:D}=await mod('adapters/platform-database');const{PostgresSessionKey:K}=await mod('adapters/postgres-session-key');const{PostgresCommunityModelAccess:A}=await mod('adapters/postgres-community-model-access');const{PlatformSessionCodec:S}=await mod('inbound/platform-session');const saved=C.open(i.config,i.data);if(saved.selection!=='builtin')throw Error('Fresh builtin required');const db=new D(saved.connection,saved.security);let key,access;try{await db.initialize();key=new K(db);access=new A(db);await key.initialize();await access.initialize();const rows=await db.query('SELECT username,space_id FROM dsh_phalanx.accounts ORDER BY username');if(rows.length<2||!rows.some(row=>row.username===i.member&&row.space_id===i.spaceId))throw Error('Unexpected installed accounts');const tokenRows=await db.query('SELECT space_id FROM dsh_phalanx.model_access_tokens WHERE space_id=$1',[i.spaceId]);if(tokenRows.length!==1)throw Error('No used member gateway token');const signing=key.read(),token=await access.forUser(i.member,i.spaceId);const bearer=/(?:^|;\s*)dsh-phalanx_session=([^;]+)/u.exec(i.cookie)?.[1];if(new S(key).verify(bearer)?.userId!==i.member)throw Error('Original member cookie does not verify');console.log(JSON.stringify({secrets:[signing,token,saved.connection.password],scope:['session-signing-key','member-gateway-token','database-password'],health:await db.health(),expectedSchema:(await mod('adapters/platform-schema')).PLATFORM_SCHEMA_VERSION,deploymentId:saved.deploymentId}));}finally{await Promise.allSettled([key?.close(),access?.close()]);await db.close()}'''
 generated=json.loads(user([current/'node/bin/node','--input-type=module','-e',program],input=json.dumps({'current':str(current),'config':str(Path(u.pw_dir)/'keys/database.json'),'data':str(data),'member':payload['member'],'spaceId':payload['spaceId'],'cookie':payload['cookie']}),timeout=60).stdout)
 assert generated['health']['state']=='connected' and generated['health']['schemaVersion']==generated['expectedSchema']
 raw=[value.encode() for value in payload['knownSecrets']+generated['secrets']]+[masterBytes];names=payload['scopes']+generated['scope']+['master-key']
 assert len(raw)==len(names) and all(len(v)>=16 for v in raw)
 assert generated['secrets'][1] in payload['knownSecrets'], 'The scanned gateway token must have been used by a member'
 needles=secret_needles(list(zip(names,raw)))
 user(['systemctl','--user','stop','dsh-phalanx.service','dsh-phalanx-postgres.service'])
 for unit in ('dsh-phalanx.service','dsh-phalanx-postgres.service'):assert unit_state(unit) in ('inactive','failed')
 scopes=[data,users,postgres,Path('/etc/dsh-phalanx/environment')];assert all(p.exists() for p in scopes)
 for relative in ('plugins/instances','mcp/members','skills/members','experts/members','platform-plugin','managed-models'):
  p=data/relative;assert p.is_dir() and any(p.iterdir()), 'Required populated scan scope missing'
 assert (users/payload['member']/'workspace/owned-result.txt').is_file()
 for name in ('shared-models.json','model-access.json','plugin-upstreams.json','mcp/library.json','plugins/access.json','execution/configuration.json'):assert not (data/name).exists()
 visited=set();files=0;total=0;links=0;hits=[];overlap=max(len(v) for _,v in needles)-1
 imageTargets=set();imageAllowed={'/opt/dsh/node_modules/@deepseek-ai/'+name for name in ('dsh-web','dsh-tools','dsh-system-prompt','dsh-credentials','dsh-tool-web','cordis')}
 allowed=[data.resolve(),users.resolve(),postgres.resolve()]
 def contained(p):return any(p.is_relative_to(a) for a in allowed)
 def scan(path):
  global files,total,links
  record['lastScannedPathSha256']=hashlib.sha256(str(path).encode()).hexdigest()
  if path.is_symlink():
   links+=1;linkText=os.readlink(path)
   if any(v in linkText.encode() for _,v in needles):hits.append({'scope':'projection-link','secretKinds':['known-secret']})
   if (not path.exists() and path.is_relative_to(data/'plugins/artifacts') and '/prepared/' in str(path.relative_to(data)) and path.parent.name=='@deepseek-ai' and path.parent.parent.name=='node_modules' and linkText in imageAllowed):
    imageTargets.add(linkText);return
   target=runtime_projection_target(path,data,u.pw_uid)
   if target is not None:record['containerRuntimeAliases']=record.get('containerRuntimeAliases',0)+1
   else:target=path.resolve(strict=True)
   assert contained(target), 'Projection link escapes owned scan roots'
   scan(target);return
  info=path.stat();identity=(info.st_dev,info.st_ino)
  if identity in visited:return
  visited.add(identity)
  if stat.S_ISDIR(info.st_mode):
   for child in path.iterdir():scan(child)
  elif stat.S_ISREG(info.st_mode):
   files+=1;count,found=scan_secret_file(path,needles);total+=count
   if found:hits.append({'pathSha256':hashlib.sha256(str(path).encode()).hexdigest(),'secretKinds':sorted(found)})
  else:assert stat.S_ISSOCK(info.st_mode), 'Unexpected physical scan entry type'
 for path in scopes:scan(path)
 assert imageTargets==imageAllowed, 'Immutable image link scope differs'
 values={}
 for line in Path('/etc/dsh-phalanx/environment').read_text().splitlines():
  key,sep,value=line.partition('=')
  if sep and key=='DSH_PHALANX_CONTAINER_IMAGE':values[key]=shlex.split(value)[0]
 image=values['DSH_PHALANX_CONTAINER_IMAGE'];inspection=json.loads(user(['podman','image','inspect',image]).stdout);assert len(inspection)==1
 imageId=inspection[0]['Id'].removeprefix('sha256:');assert len(imageId)==64 and all(c in '0123456789abcdef' for c in imageId)
 expectedRevision=json.loads((current/'runtime-versions.json').read_text())['dsh']['revision'];assert inspection[0]['Config']['Labels']['dsh.revision']==expectedRevision
 carrier='dsh-candidate-image-scan-'+str(time.time_ns())
 imageProgram=r"""const fs=require('node:fs'),path=require('node:path');let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const input=JSON.parse(raw),needles=input.needles.map(row=>({name:row.name,value:Buffer.from(row.value,'base64')}));const overlap=Math.max(...needles.map(row=>row.value.length))-1,seen=new Set(),hits=[];let files=0,bytes=0,links=0;const scan=p=>{const original=fs.lstatSync(p);if(original.isSymbolicLink()){links++;const text=fs.readlinkSync(p);if(needles.some(row=>Buffer.from(text).includes(row.value)))hits.push({secretKinds:['known-secret-in-link']})}const target=fs.realpathSync(p);if(['/proc','/sys','/dev','/tmp'].some(prefix=>target===prefix||target.startsWith(prefix+'/')))throw Error('Image link escapes immutable filesystem');const stat=fs.statSync(target),id=stat.dev+':'+stat.ino;if(seen.has(id))return;seen.add(id);if(stat.isDirectory()){for(const name of fs.readdirSync(target))scan(path.join(target,name))}else if(stat.isFile()){files++;const fd=fs.openSync(target,'r'),chunk=Buffer.alloc(65536);let tail=Buffer.alloc(0),count;try{while((count=fs.readSync(fd,chunk,0,chunk.length,null))>0){bytes+=count;const window=Buffer.concat([tail,chunk.subarray(0,count)]);for(const row of needles)if(window.includes(row.value))hits.push({secretKinds:[row.name]});tail=window.subarray(Math.max(0,window.length-overlap))}}finally{fs.closeSync(fd)}}else throw Error('Unexpected image filesystem entry')};for(const p of input.targets)scan(p);console.log(JSON.stringify({targets:input.targets,files,bytes,links,hits}));if(hits.length)process.exitCode=1});"""
 def carrierExists():
  command=['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in env.items()],'podman','container','exists',carrier]
  result=subprocess.run(command,capture_output=True);assert result.returncode in (0,1);return result.returncode==0
 try:
  imageScan=json.loads(user(['podman','run','--rm','--name',carrier,'--label','dsh-phalanx.validation=candidate-secret-scan','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--userns=keep-id','--interactive','--entrypoint','node',imageId,'-e',imageProgram],input=json.dumps({'targets':sorted(imageTargets),'needles':[{'name':name,'value':base64.b64encode(value).decode()} for name,value in needles]}),timeout=120).stdout)
  assert not imageScan['hits'] and imageScan['files']>0
 finally:
  if carrierExists():user(['podman','rm','-f',carrier])
  assert not carrierExists()
 record['immutableImageTargets']={**imageScan,'imageId':imageId,'dshRevision':expectedRevision,'carrierRemoved':True,'noNetworkOrVolumes':True,'readOnly':True}
 record.update(database=generated['health'],knownSecretKinds=names,knownSecretCount=len(raw),uniqueSecretValues=len(set(raw)),representations=len(needles),scan={'files':files,'bytes':total,'links':links,'hits':hits,'servicesStopped':True,'populatedRequiredProjections':True,'retiredJsonAbsent':True,'allPhysicalTargetsScanned':True})
 assert not hits, 'Known secret plaintext found in installed physical scope'
 time.sleep(11)
 user(['systemctl','--user','start','dsh-phalanx.service']);stopped=False
 verify=r'''import{request}from'node:http';import{readFileSync}from'node:fs';const i=JSON.parse(readFileSync(0,'utf8'));const get=()=>new Promise((resolve,reject)=>{const req=request(i.address+'/admin/api/models',{headers:{host:new URL(i.origin).host,cookie:i.adminCookie},signal:AbortSignal.timeout(10000)},async res=>{let text='';for await(const c of res)text+=c;resolve({status:res.statusCode,text})});req.on('error',reject);req.end()});let ok=false;for(let n=0;n<60;n++){try{const r=await get();if(r.status===200){const value=JSON.parse(r.text);if(value.providers.length!==1||value.providers[0].name!=='Milestone'||!value.providers[0].apiKey.configured||i.knownSecrets.some(v=>r.text.includes(v)))throw Error('Settings differ');ok=true;break}}catch{}await new Promise(r=>setTimeout(r,500))}if(!ok)throw Error('Original administrator session did not return');console.log(JSON.stringify({originalAdministratorSessionSurvived:true,providerConfigurationSurvived:true,knownSecretsAbsentInResponse:true}));'''
 record['restart']=json.loads(user([current/'node/bin/node','--input-type=module','-e',verify],input=json.dumps({**context,'knownSecrets':payload['knownSecrets']}),timeout=60).stdout)
 for unit in ('dsh-phalanx.service','dsh-phalanx-postgres.service'):assert unit_state(unit)=='active'
 record.update(status='passed',finishedAt=time.time())
except BaseException as error:
 record.update(status='failed',errorType=type(error).__name__,failedAt='physical-scan-or-restart')
finally:
 if stopped:
  time.sleep(11)
  restored=subprocess.run(['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in env.items()],'systemctl','--user','start','dsh-phalanx.service'],capture_output=True);record['restorationPassed']=restored.returncode==0
 p=scanReceipt;p.write_text(json.dumps(record,indent=2)+'\n');p.chmod(0o600)
 print(json.dumps(record))
if record['status']!='passed':raise SystemExit(1)
