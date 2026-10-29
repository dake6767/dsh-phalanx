"""Verify protected actual-execution receipts and live candidate identity; emit no secret inputs."""
import hashlib,json,os,pathlib,pwd,re,shlex,stat,subprocess,sys,tarfile
P=pathlib.Path
assert os.geteuid()==0 and len(sys.argv)==6
root=P(sys.argv[1]);candidate,tag,expected,harness=sys.argv[2],sys.argv[3],json.loads(sys.argv[4]),sys.argv[5]
assert re.fullmatch('[a-f0-9]{40}',harness)
assert root.parent==P('/var/tmp') and re.fullmatch(r'candidate-release-gate-[a-f0-9]{32}',root.name) and not root.is_symlink() and root.stat().st_uid==0 and root.stat().st_mode&0o777==0o700
def read(name):
 p=root/name;assert p.is_file() and not p.is_symlink() and p.stat().st_uid==0 and p.stat().st_mode&0o777==0o600;return json.loads(p.read_text())
def sha(path):
 with P(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
owner=read('OWNER.json');assert owner['purpose']=='candidate-release-gate' and owner['source']==candidate and owner['candidate']==tag
fresh=read('fresh-installation.json');assert fresh['status']=='passed' and fresh['emptyHostBeforeInstall'] and fresh['initialSchemaVersion']==0 and fresh['commit']==candidate and fresh['candidate']==tag
record=read('installed-acceptance.json');assert record['status']=='passed' and record['builtSource']==candidate and record['harnessSource']==harness and all(record[k] for k in ('controllerDrained','configurationRestored','serviceRestored'))
assert record['business']['status']=='passed' and record['business']['singleInstalledContext'] and record['business']['projectionRebuild']
scan=read('scan-result.json');assert scan==record['physicalScan'] and scan['status']=='passed'
assert scan['scan']['allPhysicalTargetsScanned'] and scan['scan']['populatedRequiredProjections'] and scan['scan']['servicesStopped'] and not scan['scan']['hits']
assert scan['knownSecretCount']>=14 and scan['representations']>=40 and not scan['immutableImageTargets']['hits'] and scan['immutableImageTargets']['carrierRemoved']
assert scan['masterNotInRuntime']['productProcesses']>0 and scan['masterNotInRuntime']['carrierConfigurations']>0 and scan['restart']['originalAdministratorSessionSurvived']
assert fresh['controllerSha256']==expected['freshInstallerSha256'] and fresh['installerSha256']==expected['installerSha256']
for name,digest in expected['files'].items():assert P(name).name==name and sha(root/name)==digest
assert sha(root/'harness.tar')==record['harnessArchiveSha256']
with tarfile.open(root/'harness.tar') as archive:assert archive.pax_headers.get('comment')==harness
prep=read('probe-preparation.json');u=pwd.getpwnam('dsh-phalanx');assert prep['uid']==u.pw_uid and prep['workRoot']==owner['probeWorkRoot']
assert any(x.get('kind')=='user' and x.get('name')==u.pw_name and x.get('uid')==u.pw_uid and x.get('gid')==u.pw_gid for x in owner['resources'])
assert sha('/etc/dsh-phalanx/environment')==prep['originalEnvironmentSha256']
work=P(prep['workRoot']);assert work==P(u.pw_dir)/root.name and work.is_dir() and not work.is_symlink() and work.stat().st_uid==u.pw_uid and work.stat().st_mode&0o777==0o700
assert json.loads((work/'business-result.json').read_text())==record['business']
context=json.loads((work/'context.json').read_text());scanInput=json.loads((work/'scan-input.json').read_text())
settings={k:shlex.split(v)[0] for line in P('/etc/dsh-phalanx/environment').read_text().splitlines() if line.strip() and not line.lstrip().startswith('#') for k,_,v in [line.partition('=')]}
assert context['origin']==settings['DSH_PHALANX_PUBLIC_ORIGIN'] and context['member']=='gate-'+root.name.removeprefix('candidate-release-gate-') and context['password']=='milestone-member-password'
assert scanInput['member']==context['member'] and re.fullmatch('[a-f0-9]{32}',scanInput['spaceId'])

manifest=json.loads((P(owner['bundle'])/'manifest.json').read_text());assert sha(P(owner['bundle'])/'manifest.json')==fresh['manifestSha256'] and manifest['commit']==candidate and manifest['tag']==tag
assert json.loads(P('/etc/dsh-phalanx/installed-manifest.json').read_text())==manifest
expectedAssets={**manifest['files']}
if manifest.get('updaterAsset'):expectedAssets[manifest['updaterAsset']['name']]=manifest['updaterAsset']['sha256']
assert fresh['assets']==expectedAssets
for name,digest in fresh['assets'].items():assert P(name).name==name and sha(P(owner['bundle'])/name)==digest
current=P('/opt/dsh-phalanx/current').resolve(strict=True);assert json.loads((current/'build-info.json').read_text())['commit']==candidate
state=json.loads(P('/etc/dsh-phalanx/install-state.json').read_text());assert (state['candidate'],state['commit'],state['platformSha256'],state['imageDigest'])==(tag,candidate,fresh['platformSha256'],fresh['imageDigest'])
values={}
for line in P('/etc/dsh-phalanx/environment').read_text().splitlines():
 key,sep,value=line.partition('=')
 if sep and key=='DSH_PHALANX_CONTAINER_IMAGE':values[key]=shlex.split(value)[0]
env={'HOME':u.pw_dir,'PATH':str(current/'node/bin')+':/usr/bin:/bin','XDG_RUNTIME_DIR':f'/run/user/{u.pw_uid}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{u.pw_uid}/bus'}
images=json.loads(subprocess.check_output(['runuser','-u',u.pw_name,'--','env','-i',*[k+'='+v for k,v in env.items()],'podman','image','inspect',values['DSH_PHALANX_CONTAINER_IMAGE']],cwd=u.pw_dir,text=True));assert len(images)==1 and images[0]['Digest']==manifest['image']['digest'] and images[0]['Config']['Labels']['dsh.revision']==manifest['dshRevision']
groups={record['driverProcessGroup'],record['controllerProcessGroup']};assert record['driverPid']==record['driverProcessGroup'] and record['driverPid']>1
for entry in P('/proc').glob('[0-9]*'):
 try:
  fields=(entry/'stat').read_text().rsplit(')',1)[1].split();assert not (int(fields[2]) in groups and fields[0]!='Z')
 except (FileNotFoundError,ProcessLookupError):pass
print(json.dumps({'status':'passed','harnessSource':harness,'publicOrigin':context['origin'],'member':context['member'],'spaceId':scanInput['spaceId'],'candidate':tag,'commit':candidate,'manifest':manifest,'manifestSha256':fresh['manifestSha256'],'freshInstallationReceiptSha256':sha(root/'fresh-installation.json'),'businessReceiptSha256':sha(root/'installed-acceptance.json'),'scanReceiptSha256':sha(root/'scan-result.json'),'freshInstall':True,'plaintextScan':'passed','singleInstalledContext':True,'knownSecretCount':scan['knownSecretCount'],'representations':scan['representations'],'projectionRebuild':True,'processGroupsDrained':True}))
