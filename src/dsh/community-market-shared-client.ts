/** Shared native presentation and request lifecycle; each tab owns a hook instance. */
export const nativeMarketHelpers = String.raw`
async function marketRequest(path,options){
 const response=await fetch(path,{credentials:'same-origin',...options});
 if(response.status===401){location.assign('/login');throw {error:'Sign in is required'}}
 const value=await response.json();if(!response.ok)throw value;return value;
}
function useMarketResource(path){
 const [data,setData]=React.useState();const [error,setError]=React.useState();const [busy,setBusy]=React.useState();const [revision,setRevision]=React.useState(0);
 const pending=React.useRef(false);const mounted=React.useRef(false);const saving=React.useRef();
 React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;saving.current?.abort()}},[]);
 React.useEffect(()=>{
  const controller=new AbortController();let timer;
  async function load(){try{const value=await marketRequest(path,{signal:controller.signal});if(!controller.signal.aborted){setData(value);setError(undefined)}}catch(failure){if(!controller.signal.aborted)setError(failure)}finally{if(!controller.signal.aborted)timer=setTimeout(load,5000)}}
  void load();return()=>{controller.abort();clearTimeout(timer)};
 },[path,revision]);
 async function save(name,action){
  if(pending.current)return;pending.current=true;const controller=new AbortController();saving.current=controller;setBusy(name);setError(undefined);
  try{await marketRequest(path,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({name,action})});if(mounted.current)setRevision(value=>value+1)}catch(failure){if(mounted.current)setError(failure)}finally{pending.current=false;saving.current=undefined;if(mounted.current)setBusy(undefined)}
 }
 return {data,error,busy,revision,save,reload:()=>setRevision(value=>value+1)};
}
function marketText(locale){return (key,params)=> (marketCopy[locale][key]||key).replace(/\{([a-zA-Z]+)\}/g,(match,key)=>params?.[key]===undefined?match:String(params[key]))}
function MarketFailure({error,locale}){
 const text=marketText(locale);const message=error&&((Object.hasOwn(marketErrors[locale],error.code)?marketErrors[locale][error.code]:undefined)||error.error||text('Request failed')).replace(/\{([a-zA-Z]+)\}/g,(match,key)=>error.params?.[key]===undefined?match:String(error.params[key]));
 return error?h('p',{role:'alert',className:'phalanx-market-status phalanx-market-error'},message):null;
}
function MarketContent({markdown,files,locale,title='SKILL.md'}){
 const text=marketText(locale);const labels=locale==='zh-CN'?{code:{copyLabel:'复制',copiedLabel:'已复制'},footnotes:'脚注'}:{code:{copyLabel:'Copy',copiedLabel:'Copied'},footnotes:'Footnotes'};
 return h('div',{className:'phalanx-market-detail'},
  files?h('section',{'aria-label':text('Skill files')},h('h3',null,text('Skill files')),h('ul',null,files.map(path=>h('li',{key:path},h('code',null,path))))):null,
  h('section',{'aria-label':title},h('h3',null,title),h(MarkdownText,{text:markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u,''),labels}))
 );
}
`
