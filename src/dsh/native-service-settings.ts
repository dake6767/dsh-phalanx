/** Runs in the DSH carrier so loaded personal settings never cross into the platform process. */
export const nativeServiceSettingsModule = `
import { createHash as settingsHash } from 'node:crypto';

const settingsObject=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const settingsKey=value=>typeof value==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !['constructor','prototype'].includes(value);
const settingsPath=value=>Array.isArray(value) && value.length>0 && value.length<=8 && value.every(settingsKey);
const settingsRevision=value=>Number.isSafeInteger(value) && value>=0 || typeof value==='string' && value.length>0 && value.length<=256;
const settingsValue=value=>typeof value==='string' || typeof value==='boolean';
const settingsOwn=(row,key)=>Object.hasOwn(row,key) ? row[key] : undefined;

function settingsLocation(root,path) {
  let owner=root;
  for (const segment of path.slice(0,-1)) {
    if (!Object.hasOwn(owner,segment)) owner[segment]={};
    owner=owner[segment];
    if (!settingsObject(owner)) throw new Error('Unsupported settings shape');
  }
  return [owner,path.at(-1)];
}

function settingsFingerprint(row,keys) {
  return settingsHash('sha256').update(JSON.stringify(keys.map(key=>[key,settingsOwn(row,key)]))).digest('hex');
}

function applySettingsFields(target,fields,keys) {
  for (const key of keys) {
    if (Object.hasOwn(fields,key)) target[key]=fields[key];
    else delete target[key];
  }
}

function planSettings(loaded,input) {
  const {binding,id,fields,previous=[]}=input;
  const {service,active,selection,profiles,idKey,snapshotKey}=binding;
  const keys=[...new Set(input.keys ?? Object.keys(fields))].sort();
  if (!settingsKey(service) || ![active,selection,profiles].every(settingsPath)
    || !settingsKey(idKey) || !settingsKey(snapshotKey) || typeof id!=='string'
    || !keys.length || !keys.every(settingsKey) || !Object.entries(fields).every(([key,value])=>keys.includes(key) && settingsValue(value))
    || !settingsRevision(loaded?.revision) || !settingsObject(loaded?.data))
    return {status:'unsupported'};

  const data=structuredClone(loaded.data);
  const [activeParent,activeKey]=settingsLocation(data,active);
  if (!Object.hasOwn(activeParent,activeKey)) activeParent[activeKey]={};
  const activeFields=activeParent[activeKey];
  const [selectionParent,selectionKey]=settingsLocation(data,selection);
  const [profileParent,profileKey]=settingsLocation(data,profiles);
  const selected=settingsOwn(selectionParent,selectionKey);
  const rows=Object.hasOwn(profileParent,profileKey) ? profileParent[profileKey] : [];
  if (!settingsObject(activeFields) || selected!==undefined && typeof selected!=='string'
    || !Array.isArray(rows) || !rows.every(row=>settingsObject(row) && typeof settingsOwn(row,idKey)==='string' && settingsObject(settingsOwn(row,snapshotKey)))
    || new Set(rows.map(row=>row[idKey])).size!==rows.length)
    return {status:'unsupported'};

  if (selected && !rows.some(row=>row[idKey]===selected)) return {status:'conflict'};
  const profile=rows.find(row=>row[idKey]===id);
  const fingerprint=settingsFingerprint(fields,keys);
  let observed=null;
  if (!profile) {
    if (binding.maxProfiles!==undefined && rows.length>=binding.maxProfiles) return {status:'conflict'};
    if (previous.length && !previous.includes(null) || selected===id
      || !selected && (rows.length || keys.some(key=>{
        const current=settingsOwn(activeFields,key);
        return current!==undefined && current!=='' && current!==false && current!==settingsOwn(binding.empty ?? {},key);
      })))
      return {status:'conflict'};
    profileParent[profileKey]=[...rows,{[idKey]:id,[snapshotKey]:{...fields}}];
    if (!selected) {
      selectionParent[selectionKey]=id;
      applySettingsFields(activeFields,fields,keys);
    }
  } else {
    if (!selected) return {status:'conflict'};
    const snapshot=profile[snapshotKey];
    observed=settingsFingerprint(snapshot,keys);
    if (!previous.includes(observed) || selected===id && observed!==settingsFingerprint(activeFields,keys)) return {status:'conflict'};
    if (observed===fingerprint) return {status:'applied',fingerprint,refresh:false};
    applySettingsFields(snapshot,fields,keys);
    if (selected===id) applySettingsFields(activeFields,fields,keys);
  }
  return {status:'write',fingerprint,observed,data};
}

export async function syncNativeServiceSettings(invoke,input) {
  const {service}=input.binding;
  if (!settingsKey(service)) return {status:'unsupported'};
  const load=()=>invoke(service+'/load',{});
  let loaded;
  try { loaded=await load(); }
  catch { return {status:'failed'}; }
  if (input.phase==='apply' && input.revision!==loaded?.revision) return {status:'conflict'};
  let plan;
  try { plan=planSettings(loaded,input); }
  catch { return {status:'unsupported'}; }
  if (plan.status!=='write') return plan;
  if (input.phase==='preview') return {status:'prepared',fingerprint:plan.fingerprint,observed:plan.observed,revision:loaded.revision};
  try {
    const saved=await invoke(service+'/save',{request:{revision:loaded.revision,data:plan.data}});
    if (!settingsRevision(saved?.revision) || saved.revision===loaded.revision) return {status:'failed'};
    return {status:'applied',fingerprint:plan.fingerprint,refresh:true};
  } catch {
    const current=await load().catch(()=>undefined);
    return {status:settingsRevision(current?.revision) && current.revision!==loaded.revision ? 'conflict' : 'failed'};
  }
}
`
