import { platformMessages, platformErrorMessages, type PlatformMessageKey } from '../domain/platform-copy.js'

const keys = ['Platform apps', 'Plugins published by your administrator. Install a copy into your own space.', 'Reload plugins', 'Plugin installed.', 'Plugin updated. Restart your instance to apply the new version.', 'Restart DSH instance', 'Loading…', 'No published plugins', 'Version', 'Installing…', 'Installed', 'Update available', 'Install', 'Request failed', 'All plugins'] satisfies PlatformMessageKey[]
const copy = Object.fromEntries(['en', 'zh-CN'].map(locale => [locale, Object.fromEntries(keys.map(key => [key, platformMessages[locale as 'en' | 'zh-CN'][key]]))]))

/** Own presentation only. DSH supplies the public primitives and live semantic tokens. */
export const nativeMarketCss = `
.phalanx-market{display:flex;flex-direction:column;align-items:center;gap:32px;box-sizing:border-box;height:100%;overflow:auto;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary)}
.phalanx-market>*{width:100%;max-width:960px;min-width:0}
.phalanx-market-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px}
.phalanx-market h1{margin:0;font-size:20px;line-height:28px;font-weight:500}
.phalanx-market-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.phalanx-market-refresh{flex:none}
.phalanx-market-group{display:flex;flex-direction:column;gap:8px}
.phalanx-market-group-head{display:flex;align-items:baseline;gap:8px}
.phalanx-market h2{margin:0;font-size:14px;line-height:22px;font-weight:500}
.phalanx-market-count{font-size:14px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.phalanx-market-list{display:flex;flex-direction:column;gap:2px;list-style:none;padding:0;margin:0}
.phalanx-market-row{display:flex;align-items:center;gap:14px;padding:8px 0;min-width:0}
.phalanx-market-icon{display:grid;place-items:center;flex:none;width:48px;height:48px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-secondary)}
.phalanx-market-main{flex:1;min-width:0}
.phalanx-market-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.phalanx-market h3{margin:0;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.phalanx-market-description{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.phalanx-market-action{flex:none}
.phalanx-market-status{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.phalanx-market-error{color:var(--dsw-alias-state-error-primary)}
.phalanx-market-notice{display:flex;flex-direction:column;gap:8px}
.phalanx-market-notice a{color:var(--dsw-alias-link)}
@media(max-width:600px){.phalanx-market-row{display:grid;grid-template-columns:48px minmax(0,1fr)}.phalanx-market-action{grid-column:2;justify-self:start}}
`

/** Runs inside DSH's official closure factory; never imports a feature's private implementation. */
export const nativeMarketComponent = `
const marketCopy=${JSON.stringify(copy)};
const marketErrors=${JSON.stringify(platformErrorMessages)};
function MarketPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';
 const text=key=>marketCopy[locale][key]||key;
 const [plugins,setPlugins]=React.useState();const [error,setError]=React.useState();const [notice,setNotice]=React.useState();const [busy,setBusy]=React.useState();const [revision,setRevision]=React.useState(0);const pending=React.useRef(false);const mounted=React.useRef(false);const installing=React.useRef();
 React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;installing.current?.abort()}},[]);
 async function request(options){
  const response=await fetch('/market/api/plugins',{credentials:'same-origin',...options});
  if(response.status===401){location.assign('/login');throw {error:'Sign in is required'}}
  const value=await response.json();if(!response.ok)throw value;return value;
 }
 React.useEffect(()=>{
  const controller=new AbortController();let timer;
  async function load(){try{const rows=await request({signal:controller.signal});if(!controller.signal.aborted){setPlugins(rows);setError(undefined)}}catch(failure){if(!controller.signal.aborted)setError(failure)}finally{if(!controller.signal.aborted)timer=setTimeout(load,5000)}}
  void load();return()=>{controller.abort();clearTimeout(timer)};
 },[revision]);
 async function install(packageName){
  if(pending.current)return;pending.current=true;const controller=new AbortController();installing.current=controller;setBusy(packageName);setError(undefined);setNotice(undefined);
  try{const result=await request({method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({packageName})});if(mounted.current){setNotice(result.application);setRevision(value=>value+1)}}catch(failure){if(mounted.current)setError(failure)}finally{pending.current=false;installing.current=undefined;if(mounted.current)setBusy(undefined)}
 }
 const failure=error&&((Object.hasOwn(marketErrors[locale],error.code)?marketErrors[locale][error.code]:undefined)||error.error||text('Request failed')).replace(/\\{([a-zA-Z]+)\\}/g,(match,key)=>error.params?.[key]===undefined?match:String(error.params[key]));
 return h('section',{className:'phalanx-market','aria-label':text('Platform apps')},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h1',null,text('Platform apps')),h('p',{className:'phalanx-market-intro'},text('Plugins published by your administrator. Install a copy into your own space.'))),h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-refresh',title:text('Reload plugins'),'aria-label':text('Reload plugins'),onClick:()=>setRevision(value=>value+1),icon:h(IconRefreshOutlineRegular,{size:16})})),
  error?h('p',{role:'alert',className:'phalanx-market-status phalanx-market-error'},failure):null,
  notice?h('div',{role:'status',className:'phalanx-market-notice'},h('p',{className:'phalanx-market-status'},text(notice==='applied'?'Plugin installed.':'Plugin updated. Restart your instance to apply the new version.')),notice==='restart-required'?h('a',{href:'/recovery'},text('Restart DSH instance')):null):null,
  plugins===undefined?h('p',{role:'status',className:'phalanx-market-status'},text('Loading…')):h('section',{className:'phalanx-market-group','aria-label':text('All plugins')},
   h('div',{className:'phalanx-market-group-head'},h('h2',null,text('All plugins')),h('span',{className:'phalanx-market-count'},plugins.length)),
   plugins.length===0?h('p',{className:'phalanx-market-status'},text('No published plugins')):h('ul',{className:'phalanx-market-list'},plugins.map(plugin=>h('li',{key:plugin.packageName,className:'phalanx-market-row'},
    h('span',{className:'phalanx-market-icon','aria-hidden':true},h(IconPluginPinwheelOutlineRegular,{size:24})),
    h('div',{className:'phalanx-market-main'},h('div',{className:'phalanx-market-title'},h('h3',null,plugin.title),h(Tag,{tone:'quiet'},text('Version')+' '+plugin.version)),h('p',{className:'phalanx-market-description'},plugin.description||plugin.packageName)),
    h(Button,{variant:plugin.status==='installed'?'ghost':'outline',size:'sm',className:'phalanx-market-action',disabled:busy!==undefined||plugin.status==='installed',onClick:()=>void install(plugin.packageName)},text(busy===plugin.packageName?'Installing…':plugin.status==='installed'?'Installed':plugin.status==='update'?'Update available':'Install'))
   )))
  )
 );
}
`
