/** The signed member carrier owns JSON reads and writes before the instance is opened. */
export const nativeJsonServiceSettingsModule = String.raw`
import { mkdir as makeSettingsDirectory, link as linkSettingsFile } from 'node:fs/promises';
import { randomUUID as jsonSettingsId } from 'node:crypto';

const jsonDigest = value => settingsHash('sha256').update(value).digest('hex');
const jsonDirectoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function jsonSettingsPlan(data, input) {
  if (!settingsObject(data) || !settingsObject(input.fields) || !settingsObject(input.previous)) return {status:'unsupported'};
  const next = structuredClone(data);
  const fields = Object.create(null);
  let changed = false;
  for (const declaration of input.binding.fields) {
    const path = declaration.path;
    if (!settingsPath(path)) return {status:'unsupported'};
    const key = path.join('.');
    const value = settingsOwn(input.fields,key);
    if (Object.hasOwn(fields,key) || !settingsValue(value)) return {status:'unsupported'};
    const [owner, leaf] = settingsLocation(next,path);
    const previous = settingsOwn(input.previous,key);
    const exists = Object.hasOwn(owner,leaf);
    if (exists && !settingsValue(owner[leaf])) return {status:'unsupported'};
    const current = exists ? jsonDigest(JSON.stringify(owner[leaf])) : null;
    const desired = jsonDigest(JSON.stringify(value));
    if (previous?.detached || current !== (previous?.applied ?? null) && current !== previous?.pending) {
      fields[key] = {detached:true};
      continue;
    }
    if (current === desired) {
      fields[key] = {applied:desired};
      continue;
    }
    owner[leaf] = value;
    fields[key] = {applied:current,pending:desired};
    changed = true;
  }
  if (Object.keys(fields).length !== Object.keys(input.fields).length) return {status:'unsupported'};
  return {fields,next,changed};
}

async function syncNativeJsonSettings(root, input) {
  if (process.platform !== 'linux' || typeof root !== 'string' || !root.startsWith('/')) return {status:'unsupported'};
  const file = input.binding.file;
  if (typeof file !== 'string' || file.length > 256 || !file.endsWith('.json')) return {status:'unsupported'};
  const segments = file.split('/');
  if (!segments.every(part => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.exec(part)?.[0] === part) ||
      !Array.isArray(input.binding.fields) || !input.binding.fields.length || input.binding.fields.length > 16)
    return {status:'unsupported'};

  const directories = [];
  try {
    directories.push(await open(root,jsonDirectoryFlags));
    let missing = false;
    const leaf = segments.pop();
    for (const segment of segments) {
      const path = '/proc/self/fd/' + directories.at(-1).fd + '/' + segment;
      try {
        directories.push(await open(path,jsonDirectoryFlags));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (input.phase === 'preview') { missing = true; break; }
        await makeSettingsDirectory(path,{mode:0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
        directories.push(await open(path,jsonDirectoryFlags));
      }
    }
    const parent = '/proc/self/fd/' + directories.at(-1).fd;
    const target = parent + '/' + leaf;
    const bytes = missing ? undefined : await readOptionalProfileFile(target);
    const revision = jsonDigest(bytes ? Buffer.concat([Buffer.from([1]),bytes]) : Buffer.from([0]));
    if (input.phase === 'apply' && input.revision !== revision) return {status:'conflict'};
    let plan;
    try {
      plan = jsonSettingsPlan(bytes ? JSON.parse(bytes.toString('utf8')) : {},input);
    } catch { return {status:'unsupported'}; }
    if (plan.status) return plan;
    if (!plan.changed) return {status:'applied',fields:plan.fields};
    if (input.phase === 'preview') return {status:'prepared',revision,fields:plan.fields};

    const temp = parent + '/.phalanx-settings-' + jsonSettingsId();
    const serialized = JSON.stringify(plan.next,null,2) + '\n';
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) return {status:'unsupported'};
    const handle = await open(temp,'wx',0o600);
    try {
      try {
        await handle.writeFile(serialized);
        await handle.sync();
      } finally { await handle.close(); }
      const current = await readOptionalProfileFile(target);
      if (bytes ? !current || !bytes.equals(current) : current !== undefined) return {status:'conflict'};
      if (bytes) await rename(temp,target);
      else await linkSettingsFile(temp,target);
      await directories.at(-1).sync();
      const fields = Object.fromEntries(Object.entries(plan.fields)
        .map(([key,state]) => [key,state.pending ? {applied:state.pending} : state]));
      return {status:'applied',fields};
    } finally { await rm(temp,{force:true}); }
  } catch (error) {
    return {status:['EISDIR','ENOTDIR','ELOOP'].includes(error.code) ? 'unsupported' : error.code === 'EEXIST' ? 'conflict' : 'failed'};
  } finally {
    await Promise.allSettled(directories.reverse().map(directory => directory.close()));
  }
}
`
