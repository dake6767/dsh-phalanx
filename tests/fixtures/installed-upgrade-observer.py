"""Test composition: observe the real installed executor without substituting transaction effects."""
import datetime,hashlib,json,os,pathlib,re,subprocess,sys,threading,time
P=pathlib.Path
assert os.geteuid()==0 and len(sys.argv)==2
root=P(sys.argv[1]);assert root.is_dir() and not root.is_symlink() and root.stat().st_uid==0 and root.stat().st_mode&0o777==0o700
sys.path.insert(0,'/opt/dsh-phalanx/updater')
import installer_executor as executor
from installer_upgrade_host import UpgradeHost,CURRENT
from installer_upgrade_backup import inventory
from installer_config import effective_user_data_root
from installer_executor_protocol import SOCKET
from installer_executor_install import executor_package
mutex=threading.RLock()

def atomic(path,value):
 temporary=path.with_suffix('.next');temporary.write_text(json.dumps(value,sort_keys=True)+'\n');temporary.chmod(0o600);temporary.replace(path)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
def users(path,content=True):
 rows={}
 def visit(item,key):
  try:info=item.lstat()
  except FileNotFoundError:
   if content:raise
   rows[key]={'changedDuringSnapshot':True};return
  row={'mode':info.st_mode,'uid':info.st_uid,'gid':info.st_gid,'mtimeNs':info.st_mtime_ns,'size':info.st_size}
  if item.is_symlink():row['sha256']=hashlib.sha256(os.readlink(item).encode()).hexdigest()
  elif item.is_file() and content:
   with item.open('rb') as stream:row['sha256']=hashlib.file_digest(stream,'sha256').hexdigest()
  elif item.is_dir():
   try:children=sorted(item.iterdir())
   except FileNotFoundError:
    if content:raise
    children=[];row['changedDuringSnapshot']=True
   for child in children:visit(child,child.name if key=='.' else key+'/'+child.name)
  rows[key]=row
 if path.exists() or path.is_symlink():visit(path,'.')
 return rows

def context(job):
 path=root/job['id'];path.mkdir(mode=0o700,exist_ok=True)
 file=path/'observations.json'
 if file.exists():return path,json.loads(file.read_text())
 return path,{'operation':job['id'],'sourceVersion':job['source']['manifest']['targetVersion'],'targetVersion':job['target']['manifest']['targetVersion'],'snapshots':{}}

class ObservedHost(UpgradeHost):
 def observe(self,job,hook,action):
  # Observations must never become a product failure or manufacture a restored result.
  try:return action()
  except Exception as error:
   with mutex:
    file=root/'observer-failures.json';failures=json.loads(file.read_text()) if file.exists() else []
    failures.append({'operation':job['id'],'hook':hook,'errorType':type(error).__name__});atomic(file,failures)
 def snapshot_users(self,job,stage,compare=False):
  with mutex:
   path,state=context(job);value=users(self.host.path(effective_user_data_root(job['source']['values'])),content=stage!='stopping')
   if compare:
    assert state.get('quiescentUsersSha256')==digest(value),'User files changed after old work was drained'
   if stage not in state['snapshots']:
    atomic(path/(stage+'-users.json'),value);state['snapshots'][stage]={'sha256':digest(value),'entries':len(value),'contentHashes':stage!='stopping'}
   if stage=='quiescent':state['quiescentUsersSha256']=digest(value)
   atomic(path/'observations.json',state)
 def no_instances(self,job):
  ownership=hashlib.sha256(str(P(job['source']['values']['DSH_PHALANX_DATA_ROOT']).resolve()).encode()).hexdigest()
  rows=json.loads(self.host.user(job['source']['uid'],['podman','ps','--all','--filter','label=dsh-phalanx.community=1','--filter','label=dsh-phalanx.community-root='+ownership,'--format','json']).stdout)
  assert rows==[],'A member or resident instance ran under maintenance'
 def container_filter(self,job):
  ownership=hashlib.sha256(str(P(job['source']['values']['DSH_PHALANX_DATA_ROOT']).resolve()).encode()).hexdigest()
  return ownership,['--filter','label=dsh-phalanx.community=1','--filter','label=dsh-phalanx.community-root='+ownership]
 def stopping_events(self,job,when):
  path,state=context(job)
  if 'eventWindow' in state:return
  ownership,filters=self.container_filter(job)
  ids=self.host.user(job['source']['uid'],['podman','ps','--all','--no-trunc',*filters,'--format','{{.ID}}']).stdout.splitlines()
  assert ids and all(re.fullmatch('[a-f0-9]{64}',value) for value in ids),'Missing owned drain witnesses'
  backend=json.loads(self.host.user(job['source']['uid'],['podman','info','--format','json']).stdout)['host']['eventLogger']
  assert backend in ('file','journald'),'Container events backend is unavailable'
  state['eventWindow']={'stoppingNs':when,'oldIds':ids,'root':ownership,'backend':backend};atomic(path/'observations.json',state)
 def quiescent_events(self,job):
  path,state=context(job);window=state['eventWindow']
  if 'quiescentNs' not in window:window['quiescentNs']=time.time_ns()
  atomic(path/'observations.json',state)
 def decision_events(self,job,decision):
  path,state=context(job);window=state['eventWindow'];until=time.time_ns()
  def timestamp(ns):
   seconds,fraction=divmod(ns,1000000000)
   return datetime.datetime.fromtimestamp(seconds,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')+'.'+str(fraction).zfill(9)+'Z'
  def epoch(value):
   match=re.fullmatch(r'(.*?)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)',value);assert match,'Invalid container event timestamp'
   seconds=int(datetime.datetime.fromisoformat(match[1]+match[3].replace('Z','+00:00')).timestamp())
   return seconds*1000000000+int((match[2] or '').ljust(9,'0'))
  result=self.host.user(job['source']['uid'],['podman','events','--stream=false','--since',timestamp(window['stoppingNs']),'--until',timestamp(until),'--format=json','--filter','type=container'])
  events=[json.loads(line) for line in result.stdout.splitlines() if line.strip()]
  owned=[]
  for event in events:
   attributes=event['Attributes']
   if attributes.get('dsh-phalanx.community')!='1' or attributes.get('dsh-phalanx.community-root')!=window['root']:continue
   assert re.fullmatch('[a-f0-9]{64}',event['ID']);ns=epoch(event['Time'])
   owned.append({'id':event['ID'],'status':event['Status'],'timeNs':ns})
   assert not (window['quiescentNs']<=ns<=until and event['Status'] in ('create','init','start','restart')),'A member or resident started under maintenance'
  assert all(any(row['id']==identity and row['status']=='remove' for row in owned) for identity in window['oldIds']),'Missing owned drain event witnesses'
  current=json.loads(self.host.user(job['source']['uid'],['podman','info','--format','json']).stdout)['host']['eventLogger'];assert current==window['backend']
  window.update(decision=decision,decisionNs=until,events=len(events),ownedEvents=owned,eventsSha256=hashlib.sha256(result.stdout.encode()).hexdigest(),stderrSha256=hashlib.sha256(result.stderr.encode()).hexdigest(),exitCode=result.returncode)
  atomic(path/(decision+'-events.json'),events);atomic(path/'observations.json',state)
 def database(self,job):
  source=job['source'];values=source['values'];names=[row['name'] for row in job['database']['facts']['schemas']]
  args={'config':str(self.host.path(values['DSH_PHALANX_DATABASE_CONFIG_FILE'])),'data':str(self.host.path(values['DSH_PHALANX_DATA_ROOT'])),'names':names}
  script="""import {createHash} from 'node:crypto';
import {FilePlatformDatabaseConfig} from SOURCE_CONFIG;
import {platformDatabasePool} from SOURCE_POOL;
const input=INPUT,saved=FilePlatformDatabaseConfig.open(input.config,input.data),pool=platformDatabasePool(saved.connection);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const output=[];
try {for(const name of input.names){
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(name))throw Error('Invalid observed namespace');
 const present=(await pool.query('SELECT to_regnamespace($1) IS NOT NULL AS present',[name])).rows[0].present;
 const tables=(await pool.query(\"SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','m') ORDER BY c.relname\",[name])).rows;
 const rows=[];for(const table of tables){
  const quote=value=>'"'+value.replaceAll('"','""')+'"',relation=quote(name)+'.'+quote(table.relname);
  const values=(await pool.query('SELECT to_jsonb(row)::text AS value FROM '+relation+' AS row ORDER BY to_jsonb(row)::text COLLATE "C"')).rows;
  const columns=(await pool.query(\"SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull,attidentity,attgenerated FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum\",[relation])).rows;
  rows.push({name:table.relname,rows:values.length,sha256:hash(values),columnsSha256:hash(columns)});
 }output.push({name,present,tables:rows});}
 console.log(JSON.stringify(output));}finally{await pool.end();}
""".replace('SOURCE_CONFIG',json.dumps((P(source['target'])/'dist/adapters/platform-database-config.js').as_uri())).replace('SOURCE_POOL',json.dumps((P(source['target'])/'dist/adapters/platform-database-inspection.js').as_uri())).replace('INPUT',json.dumps(args))
  path=root/job['id']/'database-observer.mjs';path.write_text(script);path.chmod(0o600)
  try:return json.loads(self.host.run([str(P(source['target'])/'node/bin/node'),str(path)]).stdout)
  finally:path.unlink(missing_ok=True)
 def save(self,job):
  when=time.time_ns()
  if job['phase'] in ('committed','restoration-committed'):
   self.observe(job,job['phase'],lambda:(self.no_instances(job),self.snapshot_users(job,job['phase'],compare=True)))
  super().save(job)
  if job['phase']=='stopping':
   self.observe(job,'stopping-events',lambda:self.stopping_events(job,when))
   self.observe(job,'stopping-users',lambda:self.snapshot_users(job,'stopping'))
  if job['phase'] in ('committed','restoration-committed'):self.observe(job,'decision-events',lambda:self.decision_events(job,job['phase']))
 def stop(self,job):
  super().stop(job)
  def stopped():
   self.no_instances(job);self.quiescent_events(job);path,state=context(job)
   if 'quiescentUsersSha256' not in state:self.snapshot_users(job,'quiescent')
   else:self.snapshot_users(job,'stopped-again',compare=True)
  self.observe(job,'stopped',stopped)
 def backup(self,job):
  def before():
   self.snapshot_users(job,'backup',compare=True)
   path,state=context(job);state['carriers']={key:inventory(value) for key,value in self.carriers(job).items()};atomic(path/'observations.json',state)
  self.observe(job,'before-backup',before)
  receipt=super().backup(job)
  def after():
   path,state=context(job);state['database']=self.database(job);state['databaseExported']=True;atomic(path/'observations.json',state)
  self.observe(job,'after-backup',after)
  return receipt
 def start(self,job):
  if job.get('committed') or job.get('restorationCommitted'):return super().start(job)
  def before():
   self.no_instances(job);self.snapshot_users(job,'before-start-'+job['phase'],compare=True)
   if job['phase']=='restoring' and self.host.path(CURRENT).resolve()==P(job['source']['target']):
    path,state=context(job)
    assert self.database(job)==state['database'],'Restored database differs before old startup'
    assert {key:inventory(value) for key,value in self.carriers(job).items()}==state['carriers'],'Restored keys or units differ'
    state['databaseRestoredBeforeStartup']=True;state['carriersRestoredBeforeStartup']=True;atomic(path/'observations.json',state)
  self.observe(job,'before-start',before)
  super().start(job)
 def verify(self,job,old=False):
  if job.get('committed') or job.get('restorationCommitted'):return super().verify(job,old)
  try:return super().verify(job,old)
  finally:self.observe(job,'after-verify',lambda:(self.no_instances(job),self.snapshot_users(job,'verified-old' if old else 'verified-target',compare=True)))

OriginalExecutor=executor.UpgradeExecutor
class ObservedExecutor(OriginalExecutor):
 def __init__(self):super().__init__(port_factory=ObservedHost)
executor.UpgradeExecutor=ObservedExecutor
account=subprocess.check_output(['getent','passwd','dsh-phalanx'],text=True).strip().split(':');assert len(account)==7
directory=P(SOCKET).parent
if not directory.exists():directory.mkdir(mode=0o750);os.chown(directory,0,int(account[3]))
identity=executor_package(P('/opt/dsh-phalanx/updater').resolve())
atomic(root/'composition.json',{'status':'observing','executor':identity,'pid':os.getpid(),'testComposition':'observed-real-host-port'})
executor.main()
