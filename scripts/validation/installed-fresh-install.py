"""Install exact candidate bytes on an empty dedicated validation host; keep secret output local."""
import hashlib,json,os,pathlib,pwd,re,shlex,stat,subprocess,sys,time
P=pathlib.Path
assert os.geteuid()==0 and len(sys.argv)==6
root,bundle,installer,tag,commit=P(sys.argv[1]),P(sys.argv[2]).resolve(strict=True),P(sys.argv[3]).resolve(strict=True),sys.argv[4],sys.argv[5]
assert root.parent==P('/var/tmp') and re.fullmatch(r'candidate-release-gate-[a-f0-9]{32}',root.name) and not root.exists() and not root.is_symlink()
assert re.fullmatch(r'run-[1-9][0-9]*',tag) and re.fullmatch('[a-f0-9]{40}',commit)
try:pwd.getpwnam('dsh-phalanx')
except KeyError:pass
else:raise RuntimeError('A dedicated empty validation host is required')
for path in ('/etc/dsh-phalanx','/var/lib/dsh-phalanx','/opt/dsh-phalanx'):
 assert not P(path).exists() and not P(path).is_symlink(), 'Existing deployment is preserved'
assert installer.is_file() and not installer.is_symlink() and bundle.is_dir()
manifest=json.loads((bundle/'manifest.json').read_text());assert manifest['tag']==tag and manifest['commit']==commit and manifest['platform']=='linux/amd64'
assets={**manifest['files']}
if manifest.get('updaterAsset'):assets[manifest['updaterAsset']['name']]=manifest['updaterAsset']['sha256']
assert {'dsh-phalanx-linux-amd64.tar.gz','dsh-phalanx-dsh-linux-amd64.oci.tar','updater.json'}<=assets.keys()
for name,digest in assets.items():
 p=bundle/name;assert p.parent==bundle and p.is_file() and not p.is_symlink()
 with p.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==digest
root.mkdir(mode=0o700)
owner={'purpose':'candidate-release-gate','source':commit,'version':manifest['targetVersion'],'candidate':tag,'bundle':str(bundle),'probeWorkRoot':'/var/lib/dsh-phalanx/'+root.name,'createdAt':time.time(),'resources':[{'kind':'directory','path':str(root),'uid':0,'gid':0}]}
def save_owner():
 p=root/'OWNER.next';p.write_text(json.dumps(owner,indent=2)+'\n');p.chmod(0o600);p.replace(root/'OWNER.json')
save_owner();receipt=root/'fresh-installation.json'
row={'status':'running','candidate':tag,'commit':commit,'manifestSha256':hashlib.sha256((bundle/'manifest.json').read_bytes()).hexdigest(),'assets':assets,'controllerSha256':hashlib.sha256(P(__file__).read_bytes()).hexdigest(),'installerSha256':hashlib.sha256(installer.read_bytes()).hexdigest(),'emptyHostBeforeInstall':True,'startedAt':time.time()}
def save():
 p=receipt.with_suffix('.next');p.write_text(json.dumps(row,indent=2)+'\n');p.chmod(0o600);p.replace(receipt)
save()
try:
 with (root/'installer-private.log').open('x') as out:
  os.fchmod(out.fileno(),0o600);result=subprocess.run(['bash',str(installer),'--version',tag,'--bundle-dir',str(bundle),'--host-public-addresses','','--listen-address','127.0.0.1','--port','18080','--public-origin','http://127.0.0.1:18080','--yes','--output','json'],stdout=out,stderr=subprocess.STDOUT)
 row['installerExitCode']=result.returncode;save();assert result.returncode==0
 u=pwd.getpwnam('dsh-phalanx');owner['resources'].append({'kind':'user','name':u.pw_name,'uid':u.pw_uid,'gid':u.pw_gid,'home':u.pw_dir});save_owner()
 current=P('/opt/dsh-phalanx/current').resolve(strict=True);installed=json.loads(P('/etc/dsh-phalanx/installed-manifest.json').read_text());state=json.loads(P('/etc/dsh-phalanx/install-state.json').read_text());assert installed==manifest
 assert json.loads((current/'build-info.json').read_text())['commit']==commit
 assert (state['candidate'],state['commit'],state['platformSha256'],state['imageDigest'])==(tag,commit,assets['dsh-phalanx-linux-amd64.tar.gz'],manifest['image']['digest'])
 env={'HOME':u.pw_dir,'PATH':str(current/'node/bin')+':/usr/bin:/bin','XDG_RUNTIME_DIR':f'/run/user/{u.pw_uid}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{u.pw_uid}/bus'}
 health=json.loads(subprocess.check_output(['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in env.items()],str(current/'start'),'database-wait','--config-file',str(P(u.pw_dir)/'keys/database.json'),'--data-root',str(P(u.pw_dir)/'data')],cwd=u.pw_dir,text=True));assert health['schemaVersion']==0
 row.update(status='passed',initialSchemaVersion=0,exactInstalledManifest=True,platformSha256=state['platformSha256'],imageDigest=state['imageDigest'])
except BaseException as error:row.update(status='failed',errorType=type(error).__name__)
finally:
 # Even a failed installer may have created the identity after the recorded empty-host preflight.
 try:
  created=pwd.getpwnam('dsh-phalanx')
  if not any(resource.get('kind')=='user' for resource in owner['resources']):
   assert created.pw_dir=='/var/lib/dsh-phalanx'
   owner['resources'].append({'kind':'user','name':created.pw_name,'uid':created.pw_uid,'gid':created.pw_gid,'home':created.pw_dir});save_owner()
 except KeyError:pass
 except BaseException as error:row.update(status='failed',ownerRecoveryErrorType=type(error).__name__)
 row['finishedAt']=time.time();save();print(json.dumps({'status':row['status'],'root':str(root),'receiptSha256':hashlib.sha256(receipt.read_bytes()).hexdigest()}))
if row['status']!='passed':raise SystemExit(1)
