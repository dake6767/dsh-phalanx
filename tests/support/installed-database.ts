interface InstalledDatabaseFacts {
  readonly databaseSelected: boolean
  readonly fingerprint: string
  readonly schemaVersion: number
  readonly retentionDays: number | null
  readonly modelRequests: number
  readonly runtimeProcesses: number
}
/** Probe only the newly installed service and its owned containers; return no secret values. */
export async function installedDatabaseFacts(
  run: (command: string, input?: string) => Promise<string>,
  options: { installationOutput?: string; requireRuntimeProcesses?: boolean } = {},
): Promise<InstalledDatabaseFacts> {
  const script = `
import assert from 'node:assert/strict';
import {readFileSync,statSync,existsSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {FilePlatformDatabaseConfig} from '/opt/dsh-phalanx/current/dist/adapters/platform-database-config.js';
import {platformDatabasePool,readPlatformDatabaseState} from '/opt/dsh-phalanx/current/dist/adapters/platform-database-inspection.js';
const data='/var/lib/dsh-phalanx/data',path='/var/lib/dsh-phalanx/keys/database.json';
const saved=FilePlatformDatabaseConfig.open(path,data),key=readFileSync(saved.security.masterKeyPath);
assert.equal(statSync(path).mode&511,384);assert.equal(statSync(saved.security.masterKeyPath).mode&511,384);assert.equal(key.length,32);
assert.ok(!existsSync(data+'/usage-records.db'),'SQLite usage file was created');
assert.ok(!readFileSync(path,'utf8').includes(saved.connection.password),'Connection password stored in plaintext');
const uid=statSync(saved.security.masterKeyPath).uid;assert.ok(uid>0);
const user=args=>execFileSync('runuser',['-u','dsh-phalanx','--',...args],{encoding:'utf8',env:{...process.env,HOME:'/var/lib/dsh-phalanx',XDG_CONFIG_HOME:'/var/lib/dsh-phalanx/.config',XDG_RUNTIME_DIR:'/run/user/'+uid,DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/'+uid+'/bus'}});
assert.equal(user(['systemctl','--user','is-active','dsh-phalanx-postgres.service']).trim(),'active');
const pid=user(['systemctl','--user','show','--property=MainPID','--value','dsh-phalanx.service']).trim();assert.match(pid,/^[1-9][0-9]*$/);
const environments=[readFileSync('/proc/'+pid+'/environ'),readFileSync('/etc/dsh-phalanx/environment')];
const roots=new Set([Number(pid)]),runtimeRoots=new Set();
for(const id of user(['podman','ps','--format','{{.ID}}']).trim().split('\\n').filter(Boolean)){
 const info=JSON.parse(user(['podman','inspect',id]))[0];environments.push(Buffer.from(JSON.stringify(info.Config.Env)));
 if(Number(info.State.Pid)>0){roots.add(Number(info.State.Pid));if(info.Name.replace(/^\\//,'')!=='dsh-phalanx-postgres')runtimeRoots.add(Number(info.State.Pid));}
}
const processes=new Map();
for(const name of readdirSync('/proc').filter(value=>/^[0-9]+$/.test(value))){
 try{const status=readFileSync('/proc/'+name+'/status','utf8');processes.set(Number(name),Number(status.match(/^PPid:\\s+(\\d+)/m)[1]));}
 catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
}
const descendants=initial=>{const found=new Set(initial);let changed=true;while(changed){changed=false;for(const [child,parent] of processes)if(found.has(parent)&&!found.has(child)){found.add(child);changed=true;}}return found;};
let runtimeProcesses=0;const runtime=descendants(runtimeRoots);
for(const child of descendants(roots)){
 try{environments.push(readFileSync('/proc/'+child+'/environ'));if(runtime.has(child))runtimeProcesses++;}
 catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
}
if(${options.requireRuntimeProcesses === true})assert.ok(runtimeProcesses>0,'No live runtime child environment was inspected');
const logs=[execFileSync('journalctl',['_SYSTEMD_USER_UNIT=dsh-phalanx.service','_UID='+uid,'--no-pager','--output=cat'],{maxBuffer:16*1024*1024}),execFileSync('journalctl',['_SYSTEMD_USER_UNIT=dsh-phalanx-postgres.service','_UID='+uid,'--no-pager','--output=cat'],{maxBuffer:16*1024*1024}),Buffer.from(${JSON.stringify(Buffer.from(options.installationOutput ?? '').toString('base64'))},'base64')];
assert.ok(logs[0].length>0,'Platform service journal was empty');
for(const file of readdirSync('/var/log/dsh-phalanx').filter(value=>value.endsWith('.jsonl')))logs.push(readFileSync('/var/log/dsh-phalanx/'+file));
for(const content of [...environments,...logs]){assert.ok(!content.includes(key),'Master key leaked into environment or logs');for(const format of ['hex','base64','base64url'])assert.ok(!content.includes(key.toString(format)),'Encoded master key leaked into environment or logs');}
assert.ok(!environments[1].includes(saved.connection.password),'Database password leaked into deployment environment');
const health=await readPlatformDatabaseState(saved.connection),db=platformDatabasePool(saved.connection);
try {
const settings=health.schemaVersion ? (await db.query('SELECT retention_days FROM dsh_phalanx.usage_settings WHERE id=1')).rows[0] : undefined;
const usage=health.schemaVersion ? (await db.query('SELECT coalesce(sum(requests),0) AS count FROM dsh_phalanx.usage_model_hours')).rows[0] : undefined;
console.log(JSON.stringify({fingerprint:saved.security.registry.masterFingerprint,databaseSelected:saved.selection!==undefined,schemaVersion:health.schemaVersion,retentionDays:settings?.retention_days??null,modelRequests:Number(usage?.count??0),runtimeProcesses}));
}finally{await db.end();key.fill(0);}
`
  return JSON.parse(await run('sudo -n /opt/dsh-phalanx/current/node/bin/node --input-type=module', script)) as InstalledDatabaseFacts
}
