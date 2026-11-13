import { createHash } from 'node:crypto'
import { nativePackageMetadata } from './native-package-metadata.js'
import { platformPluginContainerPath } from './community-platform-plugin.js'

export const nativePackageManagerFile = 'native-pnpm.mjs'
const handoff = (generation: string) => '/tmp/phalanx-native-package-' + createHash('sha256').update(generation).digest('hex').slice(0, 32) + '.json'

/** The signed RPC supplies the fixed archive and its staged cache to the configured pnpm executable. */
export function nativePackageCacheModule(generation: string) {
  return `
async function installWithNativeCache(invoke,args,signal) {
  const {cache,...nativeArgs}=args;
  if (!cache) return await invoke(nativeArgs);
  signal.throwIfAborted();
  const path=${JSON.stringify(handoff(generation))};
  await writeFile(path,JSON.stringify({spec:args.spec,cache,expires:Date.now()+660000}),{flag:'wx',mode:0o600});
  try { return await invoke(nativeArgs); }
  finally { await rm(path,{force:true}); }
}
`
}

/** Official DSH pluginManager.pnpmCommand. A matching archive alone uses offline pins and a private cache. */
export function nativePackageManager(generation: string, yaml = platformPluginContainerPath + '/yaml/dist/index.js') {
  return `#!/usr/bin/env node
import {execFile,spawn} from 'node:child_process';
import {cp,mkdir,open,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {basename,isAbsolute,join,relative} from 'node:path';
import {promisify} from 'node:util';

import {parseDocument,isMap} from ${JSON.stringify(yaml)};

const args=process.argv.slice(2);
const validPackage=identity=>identity && typeof identity.packageName==='string'
  && /^(?:@[a-z0-9._-]+[/])?[a-z0-9][a-z0-9._-]*$/.test(identity.packageName)
  && typeof identity.version==='string' && /^[0-9][A-Za-z0-9.+-]{0,100}$/.test(identity.version);

async function handoff() {
  if (args[0]!=='add') return;
  let handle;
  try { handle=await open(${JSON.stringify(handoff(generation))},constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
  catch(error) { if (error?.code==='ENOENT') return; throw error; }
  try {
    const stat=await handle.stat();
    if (!stat.isFile() || stat.size>16384) throw new Error('Invalid native cache handoff');
    const {spec,cache,expires}=JSON.parse(await handle.readFile('utf8'));
    if (args[1]!==spec || expires<Date.now()) return;
    if (typeof cache?.directory!=='string' || !/^[/]tmp[/]phalanx-native-cache-[A-Za-z0-9]{10}$/.test(cache.directory)
      || !validPackage(cache.owner) || !Array.isArray(cache.packages) || !cache.packages.length || !cache.packages.every(validPackage))
      throw new Error('Invalid native cache handoff');
    return cache;
  } finally { await handle.close(); }
}

async function runPnpm(env) {
  return await new Promise((resolve,reject)=>{
    const child=spawn('pnpm',args,{stdio:'inherit',env});
    child.once('error',reject);
    child.once('close',code=>resolve(code ?? 1));
  });
}

async function atomicWrite(path,contents) {
  const temporary=path+'.phalanx-'+randomUUID();
  try {
    await writeFile(temporary,contents,{flag:'wx',mode:0o600});
    await rename(temporary,path);
  } finally { await rm(temporary,{force:true}); }
}

async function pnpmQuery(query) {
  const registry=args.filter(arg=>arg.startsWith('--registry=') || arg.startsWith('--config.registry=')).map(arg=>arg.replace(/^--registry=/,'--config.registry='));
  const {stdout}=await promisify(execFile)('pnpm',[...query,...registry],{encoding:'utf8',timeout:10000,maxBuffer:4096});
  return stdout.trim();
}

async function pnpmPath(kind) {
  const path=await pnpmQuery([kind,'path']);
  if (!isAbsolute(path) || path.includes('\\n')) throw new Error('Invalid native pnpm '+kind+' path');
  return path;
}

function registryCacheKey(address) {
  const registry=new URL(address);
  if (!['http:','https:'].includes(registry.protocol) || !registry.hostname || registry.username || registry.password)
    throw new Error('Invalid native pnpm registry');
  const escape=value=>encodeURIComponent(value).replace(/[!'()*~]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase());
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const segments=registry.pathname.slice(1).split('/');
  if (segments.at(-1)==='') segments.pop();
  const path=segments.join('/');
  let key=registry.protocol.slice(0,-1)+'%3A+'+escape(registry.hostname)+(registry.port ? '+'+registry.port : '');
  if (segments.length) key+='%2F'+segments.map(escape).join('+')+(path!==path.toLowerCase() ? '%5F'+digest(path) : '');
  if (key.endsWith('.')) key=key.slice(0,-1)+'%2E';
  return key.length>255 ? digest(key) : key;
}

async function copyMetadata(source,target) {
  await cp(source,target,{recursive:true,force:false}).catch(error=>{
    if (error?.code!=='ENOENT') throw error;
  });
}

${nativePackageMetadata}
async function prepareNativeMetadata(metadata) {
  await mkdir(metadata,{recursive:true});
  const source=registryCacheKey('https://registry.npmjs.org');
  const target=registryCacheKey(await pnpmQuery(['config','get','registry']));
  if (target!==source) {
    // Alias the immutable public seed only inside this operation's cache.
    for (const kind of ['metadata','metadata-full','metadata-full-filtered']) {
      const directory=join(metadata,'v12',kind);
      await copyMetadata(join(directory,source),join(directory,target));
    }
  }
  const live=join(await pnpmPath('cache'),'v12'), stage=join(metadata,'v12');
  await mergeNativeMetadata(live,stage);
  await copyMetadata(live,stage);
}

async function mergeNativeStore(directory) {
  const {DatabaseSync}=await import('node:sqlite');
  const store=await pnpmPath('store');
  if (!/^v[0-9]+$/.test(basename(store))) throw new Error('Invalid native pnpm store layout');
  const seed=join(directory,'store',basename(store));
  await mkdir(store,{recursive:true});
  await cp(join(seed,'files'),join(store,'files'),{recursive:true,force:false});
  const source=new DatabaseSync(join(seed,'index.db'),{readOnly:true});
  try {
    const target=new DatabaseSync(join(store,'index.db'));
    try {
      target.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS package_index (key TEXT PRIMARY KEY,data BLOB NOT NULL) WITHOUT ROWID; BEGIN IMMEDIATE');
      const insert=target.prepare('INSERT OR IGNORE INTO package_index(key,data) VALUES(?,?)');
      for (const row of source.prepare('SELECT key,data FROM package_index').iterate()) insert.run(row.key,row.data);
      target.exec('COMMIT');
    } finally { target.close(); }
  } finally { source.close(); }
}

async function runWithCache(cache) {
  const path=join(process.cwd(),'pnpm-workspace.yaml');
  const readWorkspace=()=>readFile(path,'utf8').catch(error=>{ if (error?.code!=='ENOENT') throw error; });
  const original=await readWorkspace();
  const workspace=parseDocument(original ?? '{}');
  if (workspace.errors.length || !isMap(workspace.contents)) throw new Error('Unsupported pnpm workspace shape');
  const overrides=workspace.get('overrides',true);
  if (overrides!==undefined && !isMap(overrides)) throw new Error('Unsupported pnpm overrides shape');
  const {directory,owner,packages}=cache;
  for (const item of packages) {
    const selector=owner.packageName+'@'+owner.version+'>'+item.packageName;
    const current=workspace.getIn(['overrides',selector]);
    if (current!==undefined && current!==item.version) throw new Error('Conflicting pnpm override');
    workspace.setIn(['overrides',selector],item.version);
  }
  await mergeNativeStore(directory);
  const metadata=join(directory,'metadata');
  await prepareNativeMetadata(metadata);
  const next=workspace.toString();
  if (await readWorkspace()!==original) throw new Error('Native pnpm workspace changed');
  if (next!==original) await atomicWrite(path,next);
  let success=false;
  try {
    const code=await runPnpm({...process.env,
      PNPM_CONFIG_CACHE_DIR:metadata,
      pnpm_config_cache_dir:metadata,
      PNPM_CONFIG_OFFLINE:'true',
      pnpm_config_offline:'true',
      PNPM_CONFIG_IGNORE_SCRIPTS:'true',
      pnpm_config_ignore_scripts:'true',
    });
    success=code===0;
    return code;
  } finally {
    if (!success && next!==original && await readWorkspace()===next) {
      if (original===undefined) await rm(path,{force:true});
      else await atomicWrite(path,original);
    }
  }
}

const cache=await handoff();
process.exitCode=cache ? await runWithCache(cache) : await runPnpm(process.env);
`
}
