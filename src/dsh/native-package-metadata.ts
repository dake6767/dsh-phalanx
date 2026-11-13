/** The pinned pnpm 11 cache accepts compact indexed records and the two-line npm packument format. */
export const nativePackageMetadata = `
async function readNativePackument(path) {
  const size=(await stat(path)).size;
  if (size>64*1024*1024) throw new Error('Native pnpm metadata is too large');
  const data=await readFile(path);
  const end=data.indexOf(10);
  if (end<1) throw new Error('Unsupported native pnpm metadata');
  const header=data.toString('utf8',0,end);
  const indexed=/^pnpm-meta-v1 (\\d+) (\\d+)$/.exec(header);
  if (!indexed) {
    JSON.parse(header);
    return JSON.parse(data.toString('utf8',end+1));
  }
  const start=end+1, summary=start+Number(indexed[1]), records=summary+Number(indexed[2]);
  if (!Number.isSafeInteger(records) || records>data.length) throw new Error('Invalid native pnpm metadata');
  const envelope=JSON.parse(data.toString('utf8',start,summary));
  const info=JSON.parse(data.toString('utf8',summary,records));
  const versions=Object.fromEntries(info.versions.map(([version,offset,length])=>{
    const end=records+offset+length;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset<0 || length<1 || end>data.length)
      throw new Error('Invalid native pnpm metadata record');
    return [version,JSON.parse(data.toString('utf8',records+offset,end))];
  }));
  return {name:info.name,'dist-tags':info.distTags,versions,time:info.time,modified:envelope.modified};
}

async function mergeNativeMetadata(live,stage) {
  const files=await readdir(stage,{recursive:true,withFileTypes:true}).catch(error=>{
    if (error?.code==='ENOENT') return [];
    throw error;
  });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const target=join(file.parentPath,file.name);
    const existing=join(live,relative(stage,target));
    const previous=await readNativePackument(existing).catch(error=>{
      if (error?.code!=='ENOENT') throw error;
    });
    if (!previous) continue;
    const seed=await readNativePackument(target);
    if (typeof seed.name!=='string' || seed.name!==previous.name || !seed.versions || !previous.versions)
      throw new Error('Conflicting native pnpm metadata');
    for (const [version,value] of Object.entries(seed.versions)) {
      const existing=Object.hasOwn(previous.versions,version) ? previous.versions[version] : undefined;
      const kind=value?.dist?.integrity && existing?.dist?.integrity ? 'integrity' : 'shasum';
      const a=value?.dist?.[kind];
      const b=existing?.dist?.[kind];
      if (a && b && a!==b) throw new Error('Conflicting native pnpm package identity');
    }
    const packument={
      name:seed.name,
      'dist-tags':{...seed['dist-tags'],...previous['dist-tags']},
      versions:{...seed.versions,...previous.versions},
      ...(seed.time || previous.time ? {time:{...seed.time,...previous.time}} : {}),
      modified:[seed.modified,previous.modified].filter(value=>typeof value==='string').sort().at(-1),
    };
    await atomicWrite(target,'{}\\n'+JSON.stringify(packument)+'\\n');
  }
}
`
