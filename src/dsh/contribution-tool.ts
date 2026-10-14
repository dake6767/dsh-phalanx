/** Official global tools, embedded skills and foreground userQuestions seams. */
export const contributionGuide = `# Contributing a skill\nRead the skill, describe its purpose, then call submit_contribution with action submit, its directory path, and purpose. The member must click Submit before any upload. Never supply confirmation on their behalf. Sub-agents must return to the main conversation. The tool excludes .env files, private keys and certificates. Remove credentials from all remaining files. Skills must contain one SKILL.md, use a unique name, and fit within 20 MB. Pending submissions with the same name replace your earlier submission. Use action status to query and action withdraw with an id to withdraw. Adoption creates an independent platform copy, without changing your local copy.`
export const contributionToolModule = `
import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { crc32 } from 'node:zlib';
import { parse } from './yaml/dist/index.js';
const guide=${JSON.stringify(contributionGuide)};
export const name='phalanx-contribution-tools';
export const inject=['tools','userQuestions','agents','skills'];
function zip(files){
 const entries=[],index=[];let offset=0;
 for(const file of files){
  const name=Buffer.from(file.path),header=Buffer.alloc(30),central=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
  header.writeUInt32LE(crc32(file.bytes),14);header.writeUInt32LE(file.bytes.length,18);header.writeUInt32LE(file.bytes.length,22);header.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x0314,4);header.copy(central,6,4,30);central.writeUInt32LE((0o100555*65536)>>>0,38);central.writeUInt32LE(offset,42);
  entries.push(header,name,file.bytes);index.push(central,name);offset+=header.length+name.length+file.bytes.length;
 }
 const directory=Buffer.concat(index),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...entries,directory,end]);
}
async function pack(path,signal){
 const root=await realpath(path),files=[],excluded=[];let size=0;
 async function walk(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   signal.throwIfAborted();const full=join(directory,entry.name),path=relative(root,full);
   if(entry.name.startsWith('.env')||/\\.(pem|key|p12|pfx|crt|cer)$/i.test(entry.name)||['.git','node_modules'].includes(entry.name)){excluded.push(path);continue}
   if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw new Error('contribution-unsafe-file: Remove links and special files.');
   if(entry.isDirectory()){await walk(full);continue}
   const stat=await lstat(full);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('contribution-unsafe-file');
   const canonical=await realpath(full),rel=relative(root,canonical);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('contribution-unsafe-file');
   size+=stat.size;if(size>20*1024*1024||files.length>=10000)throw new Error('skill-upload-too-large: Limit the skill to 20 MB and 10000 files.');
   const bytes=await readFile(full);if(bytes.length!==stat.size)throw new Error('contribution-changed: Review changed files again.');
   if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString('utf8')))throw new Error('contribution-credential: Remove the private key and declare a credential name instead.');
   files.push({path,bytes});
  }
 }
 await walk(root);if(!files.some(file=>file.path==='SKILL.md'))throw new Error('skill-frontmatter-invalid: Select a directory containing SKILL.md.');
 const bytes=zip(files);if(bytes.length>20*1024*1024)throw new Error('skill-upload-too-large');
 const markdown=files.find(file=>file.path==='SKILL.md').bytes.toString('utf8'),frontmatter=/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/.exec(markdown);
 let name;try{name=parse(frontmatter?.[1]||'',{logLevel:'silent'})?.name}catch{}
 if(typeof name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw new Error('skill-frontmatter-invalid: Add a valid skill name to SKILL.md.');
 return {bytes,name,files:files.map(file=>file.path),excluded};
}
export function apply(ctx){
 ctx.skills.register({name:'platform-contribution-guide',description:'Submit a skill or plugin to the platform after the member confirms.',source:'runtime',content:guide});
 ctx.tools.register({name:'submit_contribution',description:'Contribute a skill to the platform for administrator review. Read this guide first: '+guide,
 parameters:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['submit','status','withdraw']},path:{type:'string'},purpose:{type:'string'},id:{type:'string'}},required:['action']},
 output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
 async execute(args,exec){
  if(!exec.agent||!ctx.agents.roots().includes(exec.agent))return {code:'contribution-main-session-required',advice:'Return to the main conversation to submit. 需在主会话提交。'};
  const endpoint=new URL('/contributions',process.env.DSH_PHALANX_MODEL_GATEWAY_URL);
  const headers={'x-api-key':process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN};let init={headers,signal:exec.signal};
  if(args.action==='withdraw'){endpoint.searchParams.set('action','withdraw');init={...init,method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({id:args.id})}}
  else if(args.action==='submit'){
   if(typeof args.path!=='string'||typeof args.purpose!=='string'||!args.purpose.trim())return {code:'contribution-invalid',advice:'Provide a skill directory and purpose.'};
   const packed=await pack(resolve(exec.agent.session.header.cwd||process.cwd(),args.path),exec.signal);
   const detail='Skill / 技能: '+packed.name+'\\n\\n'+args.purpose+'\\n\\nFiles ('+packed.files.length+'):\\n'+packed.files.join('\\n')+'\\n\\nExcluded:\\n'+(packed.excluded.join('\\n')||'None');
   const answer=await ctx.userQuestions.ask({agent:exec.agent,signal:exec.signal,questions:[{id:'submit-contribution',header:'Submit contribution / 提交贡献',question:'Submit this skill to the platform? / 将此技能提交到平台？',detail,options:[{label:'Submit / 提交'},{label:'Cancel / 取消'}]}]});
   if(answer.answers.length!==1||answer.answers[0].selected.length!==1||answer.answers[0].selected[0]!=='Submit / 提交')return {status:'cancelled'};
   exec.signal.throwIfAborted();endpoint.searchParams.set('action','submit');init={...init,method:'POST',headers:{...headers,'content-type':'application/zip','x-contribution-declaration':Buffer.from(JSON.stringify({purpose:args.purpose})).toString('base64url')},body:packed.bytes};
  }
  const response=await fetch(endpoint,init);return await response.json();
 }});
}
`
