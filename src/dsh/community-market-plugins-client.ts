/** The panel observes accepted background work; closing it never cancels installation. */
export const nativePluginsTab = `
function PluginsPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';
 const text=marketText(locale);
 const [plugins,setPlugins]=React.useState();const [error,setError]=React.useState();const [notice,setNotice]=React.useState();const [busy,setBusy]=React.useState();const [revision,setRevision]=React.useState(0);const pending=React.useRef(false);const mounted=React.useRef(false);const observing=React.useRef();
 React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;observing.current?.abort()}},[]);
 const request=options=>marketRequest('/market/api/plugins',options);
 React.useEffect(()=>{
  const controller=new AbortController();let timer;
  async function load(){let active=false;try{const rows=await request({signal:controller.signal});if(!controller.signal.aborted){setPlugins(rows.plugins);setNotice(rows.pending?'restart-required':undefined);setError(undefined);active=rows.plugins.some(plugin=>plugin.job?.status==='running')}}catch(failure){if(!controller.signal.aborted)setError(failure)}finally{if(!controller.signal.aborted)timer=setTimeout(load,active?750:5000)}}
  void load();return()=>{controller.abort();clearTimeout(timer)};
 },[revision]);
 async function install(packageName,action){
  if(pending.current)return;pending.current=true;const controller=new AbortController();observing.current=controller;setBusy(packageName);setError(undefined);setNotice(undefined);
  const requestId=Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).join('-');
  try{const result=await request({method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({packageName,action,requestId})});if(mounted.current){if(result.job)setPlugins(rows=>rows?.map(plugin=>plugin.packageName===packageName?{...plugin,job:result.job}:plugin));setNotice(result.application);setRevision(value=>value+1)}}catch(failure){if(mounted.current)setError(failure)}finally{pending.current=false;observing.current=undefined;if(mounted.current)setBusy(undefined)}
 }
 function row(plugin){
  const running=plugin.job?.status==='running';const removing=plugin.job?.action==='uninstall';const failed=plugin.job?.status==='failed';const removable=plugin.status==='selected'||plugin.status==='installed';
  const phase=plugin.job?.phase==='downloading'?'Downloading plugin…':plugin.job?.phase==='installing'?'Installing plugin…':plugin.job?.phase==='removing'?'Removing plugin…':'Preparing installation…';
  return h('li',{key:plugin.packageName,className:'phalanx-market-row'},
   h('span',{className:'phalanx-market-icon','aria-hidden':true},h(IconPluginPinwheelOutlineRegular,{size:24})),
   h('div',{className:'phalanx-market-main'},h('div',{className:'phalanx-market-title'},h('h3',null,plugin.title),h(Tag,{tone:'quiet'},text('Version')+' '+plugin.version),plugin.status==='managed'?h(Tag,{tone:'quiet'},text('Platform controlled, cannot uninstall')):null,plugin.sharedCredential?h(Tag,{tone:'quiet'},text('Platform shared KEY')):null),
    h('p',{className:'phalanx-market-description'},plugin.description||plugin.packageName),plugin.contribution?h('p',{className:'phalanx-market-description'},text(plugin.contribution.anonymous?'Contributed anonymously':'Contributed by {name}',{name:plugin.contribution.name})):null,
    h('p',{className:'phalanx-market-status'},text(plugin.status==='native'?'Installed on the native plugin page':plugin.status==='install'?'Not installed':'Installed')),
    running?h('div',{role:'status'},h('p',{className:'phalanx-market-status'},text(phase)),h('progress',{'aria-label':text(phase)})):null,
    failed?h(MarketFailure,{error:plugin.job.failure,locale}):null),
   h(Button,{variant:plugin.status==='managed'||plugin.status==='native'?'ghost':'outline',size:'sm',className:'phalanx-market-action',disabled:busy!==undefined||running||plugin.status==='managed'||plugin.status==='native',onClick:()=>void install(plugin.packageName,removable?'uninstall':'install')},text(running?(removing?'Removing…':'Installing…'):busy===plugin.packageName?'Saving…':plugin.status==='managed'||plugin.status==='native'?'Installed':failed&&removable&&removing?'Retry uninstall':failed&&!removable&&!removing?'Retry installation':removable?'Uninstall':'Install'))
  );
 }
 return h('div',{className:'phalanx-market-tab-content'},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('Plugins')),h('p',{className:'phalanx-market-intro'},text('Install plugins into your DSH. Shared-key and controlled plugins load read-only.'))),h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-refresh',title:text('Reload plugins'),'aria-label':text('Reload plugins'),onClick:()=>setRevision(value=>value+1),icon:h(IconRefreshOutlineRegular,{size:16})})),
  h(MarketFailure,{error,locale}),
  notice?h('div',{role:'status',className:'phalanx-market-notice'},h('p',{className:'phalanx-market-status'},text(notice==='applied'?'Selection saved.':'Changes take effect after restarting your instance.')),notice==='restart-required'?h('a',{href:'/recovery?restart=1'},text('Restart DSH instance')):null):null,
  plugins===undefined?h('p',{role:'status',className:'phalanx-market-status'},text('Loading…')):h('section',{className:'phalanx-market-group','aria-label':text('All plugins')},
   h('div',{className:'phalanx-market-group-head'},h('h2',null,text('All plugins')),h('span',{className:'phalanx-market-count'},plugins.length)),
   plugins.length===0?h('p',{className:'phalanx-market-status'},text('No published plugins')):h('ul',{className:'phalanx-market-list'},plugins.map(row))
  )
 );
}
`
