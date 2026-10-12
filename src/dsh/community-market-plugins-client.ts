/** Plugin tab owns its requests and install lifecycle inside the native panel. */
export const nativePluginsTab = `
function PluginsPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';
 const text=key=>marketCopy[locale][key]||key;
 const [plugins,setPlugins]=React.useState();const [error,setError]=React.useState();const [notice,setNotice]=React.useState();const [busy,setBusy]=React.useState();const [revision,setRevision]=React.useState(0);const pending=React.useRef(false);const mounted=React.useRef(false);const installing=React.useRef();
 React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;installing.current?.abort()}},[]);
 const request=options=>marketRequest('/market/api/plugins',options);
 React.useEffect(()=>{
  const controller=new AbortController();let timer;
  async function load(){try{const rows=await request({signal:controller.signal});if(!controller.signal.aborted){setPlugins(rows.plugins);setNotice(rows.pending?'restart-required':undefined);setError(undefined)}}catch(failure){if(!controller.signal.aborted)setError(failure)}finally{if(!controller.signal.aborted)timer=setTimeout(load,5000)}}
  void load();return()=>{controller.abort();clearTimeout(timer)};
 },[revision]);
 async function install(packageName,action){
  if(pending.current)return;pending.current=true;const controller=new AbortController();installing.current=controller;setBusy(packageName);setError(undefined);setNotice(undefined);
  try{const result=await request({method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({packageName,action})});if(mounted.current){setNotice(result.application);setRevision(value=>value+1)}}catch(failure){if(mounted.current)setError(failure)}finally{pending.current=false;installing.current=undefined;if(mounted.current)setBusy(undefined)}
 }

 return h('div',{className:'phalanx-market-tab-content'},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('Plugins')),h('p',{className:'phalanx-market-intro'},text('Changes take effect after restarting your instance.'))),h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-refresh',title:text('Reload plugins'),'aria-label':text('Reload plugins'),onClick:()=>setRevision(value=>value+1),icon:h(IconRefreshOutlineRegular,{size:16})})),
  h(MarketFailure,{error,locale}),
  notice?h('div',{role:'status',className:'phalanx-market-notice'},h('p',{className:'phalanx-market-status'},text(notice==='applied'?'Selection saved.':'Changes take effect after restarting your instance.')),notice==='restart-required'?h('a',{href:'/recovery?restart=1'},text('Restart DSH instance')):null):null,
  plugins===undefined?h('p',{role:'status',className:'phalanx-market-status'},text('Loading…')):h('section',{className:'phalanx-market-group','aria-label':text('All plugins')},
   h('div',{className:'phalanx-market-group-head'},h('h2',null,text('All plugins')),h('span',{className:'phalanx-market-count'},plugins.length)),
   plugins.length===0?h('p',{className:'phalanx-market-status'},text('No published plugins')):h('ul',{className:'phalanx-market-list'},plugins.map(plugin=>h('li',{key:plugin.packageName,className:'phalanx-market-row'},
    h('span',{className:'phalanx-market-icon','aria-hidden':true},h(IconPluginPinwheelOutlineRegular,{size:24})),
    h('div',{className:'phalanx-market-main'},h('div',{className:'phalanx-market-title'},h('h3',null,plugin.title),h(Tag,{tone:'quiet'},text('Version')+' '+plugin.version)),h('p',{className:'phalanx-market-description'},plugin.description||plugin.packageName),h('p',{className:'phalanx-market-status'},text(plugin.status==='managed'?'Installed (platform preinstalled)':plugin.status==='selected'?'Installed (platform app center)':plugin.status==='native'?'Installed on the native plugin page':'Not installed')),plugin.status==='native'?h('p',{className:'phalanx-market-description'},text('Uninstall on the native plugin page before selecting this platform app.')):null),
    h(Button,{variant:plugin.status==='managed'||plugin.status==='native'?'ghost':'outline',size:'sm',className:'phalanx-market-action',disabled:busy!==undefined||plugin.status==='managed'||plugin.status==='native',onClick:()=>void install(plugin.packageName,plugin.status==='selected'?'uninstall':'install')},text(busy===plugin.packageName?'Saving…':plugin.status==='selected'?'Uninstall':plugin.status==='managed'||plugin.status==='native'?'Installed':'Install'))
   )))
  )
 );
}
`
