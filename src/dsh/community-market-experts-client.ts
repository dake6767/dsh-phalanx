/** Expert cards use the same public native controls and isolated resource lifecycle as other tabs. */
export const nativeExpertsTab = `
// Launch dependencies activate locally, independently of other market tabs.
const expertLaunchListeners=new Set();let expertLaunchServices;
const expertLaunchSubscribe=listener=>{expertLaunchListeners.add(listener);return()=>expertLaunchListeners.delete(listener)};
const expertLaunchSnapshot=()=>expertLaunchServices;
ctx.inject(['sessions','workspaces','uiWorkspace','layout','remote','remote.session'],scope=>{
 scope.effect(()=>{
  const controller=new AbortController();
  expertLaunchServices={sessions:scope.sessions,workspaces:scope.workspaces,uiWorkspace:scope.uiWorkspace,layout:scope.layout,remote:scope.remote,signal:controller.signal};
  for(const listener of expertLaunchListeners)listener();
  return()=>{controller.abort();expertLaunchServices=undefined;for(const listener of expertLaunchListeners)listener()};
 });
});
// Startup navigation must consume its catalog baseline before it can discover this new expert blank.
function waitForExpertCatalogs(services){
 return new Promise((resolve,reject)=>{
  const signal=services.signal;const stops=[];let settled=false;
  const finish=failure=>{
   if(settled)return;settled=true;
   for(const stop of stops.splice(0))stop();signal.removeEventListener('abort',cancel);
   failure===undefined?resolve():reject(failure);
  };
  const cancel=()=>finish(signal.reason);
  const stores=[services.sessions.list,services.workspaces.list];
  const check=()=>{
   if(settled)return;
   try{
    if(signal.aborted){cancel();return}
    const snapshots=stores.map(store=>store.getSnapshot());
    if(snapshots.some(snapshot=>snapshot.error)){finish({code:'expert-unavailable'});return}
    if(snapshots.every(snapshot=>snapshot.phase==='ready'))finish();
   }catch(error){finish(error)}
  };
  signal.addEventListener('abort',cancel,{once:true});
  for(const store of stores){if(settled)break;const stop=store.subscribe(check);if(settled)stop();else stops.push(stop)}
  check();
 });
}
async function launchExpertConversation(services,plan){
 await waitForExpertCatalogs(services);
 services.signal.throwIfAborted();
 // Cancel startup's pending initialization before it can reconnect a new expert blank as the default.
 const navigation=AbortSignal.any([services.signal,services.layout.beginNavigation()]);
 const workspace=services.workspaces.list.getSnapshot().items[0]||await services.workspaces.initializeDefault(navigation);
 navigation.throwIfAborted();
 if(!workspace)throw {code:'expert-unavailable'};
 const {sessionId}=await marketRequest(new URL('api/phalanx.expert-conversation',document.baseURI).href,{method:'POST',signal:navigation,headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId:workspace.workspaceId,agentPreset:plan.agentPreset,model:plan.model,...(plan.reasoningEffort?{reasoningEffort:plan.reasoningEffort}:{})})});
 navigation.throwIfAborted();
 services.uiWorkspace.openSession(sessionId);
}
function ExpertsPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource('/market/api/experts');const {data,error,busy}=resource;
 const services=React.useSyncExternalStore(expertLaunchSubscribe,expertLaunchSnapshot);
 const [launchError,setLaunchError]=React.useState();const [launching,setLaunching]=React.useState();const launchPending=React.useRef(false);
 async function start(id){
  if(!services||launchPending.current)return;launchPending.current=true;setLaunching(id);setLaunchError(undefined);
  try{
   const plan=await marketRequest('/market/api/experts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:id,action:'start'})});
   await launchExpertConversation(services,plan,text('Request failed'));
  }catch(failure){setLaunchError(failure)}finally{launchPending.current=false;setLaunching(undefined)}
 }
 return h('section',{className:'phalanx-market-tab-content phalanx-market-structured','aria-label':text('Experts')},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('Experts')),
   h('p',{className:'phalanx-market-intro'},text('Summoning gives you access to all expert entries and platform credentials throughout your instance, including entries not granted separately.')),
   h('p',{className:'phalanx-market-intro'},text('Dismissing an expert immediately withdraws its exclusive access. After restarting, its sessions cannot continue; history is retained.'))),h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-refresh',onClick:resource.reload,title:text('Reload experts'),'aria-label':text('Reload experts'),icon:h(IconRefreshOutlineRegular,{size:16})})),
  data?.pending?h('div',{className:'phalanx-market-notice',role:'status'},h('p',null,text('Changes take effect after restarting your instance.')),h('a',{href:'/recovery?restart=1'},text('Restart DSH instance'))):null,
  h(MarketFailure,{error:launchError||error,locale}),!data?h('p',{role:'status'},text('Loading…')):!data.experts.length?h('p',null,text('No experts yet')):
  h('ul',{className:'phalanx-market-list'},data.experts.map(expert=>h('li',{key:expert.id,className:'phalanx-market-row'},
   h('div',{className:'phalanx-market-main'},h('div',{className:'phalanx-market-title'},h('span',{'aria-hidden':true},expert.icon||'✦'),h('h3',null,expert.name)),h('p',{className:'phalanx-market-description'},expert.description),
    h('p',{className:'phalanx-market-description'},expert.modelLabel||text('Host default model')),

    expert.reasoningUnavailable?h('p',{className:'phalanx-market-status'},text('Reasoning unavailable')):null,
    expert.checking?h('p',{className:'phalanx-market-status'},text('Checking capabilities…')):null,
    expert.partial?h('p',{className:'phalanx-market-status'},text('Some capabilities are temporarily unavailable.')):null,
    h('details',{className:'phalanx-market-disclosure'},h('summary',null,text('Included entries')),
    expert.examples.length?h('section',{'aria-label':text('Example tasks')},h('h4',null,text('Example tasks')),h('ul',null,expert.examples.map(example=>h('li',{key:example},example)))):null,
    h('ul',null,[['Expert plugins',expert.plugins],['Expert skills',expert.skills],['Expert skill packs',expert.skillPacks],['MCP services',expert.mcp]].flatMap(([kind,names])=>names.map(name=>h('li',{key:kind+':'+name},text(kind)+': '+name))))),
    expert.status==='granted'?h('p',{className:'phalanx-market-status'},text('Experts granted by your group cannot be dismissed.')):null),
   h('div',{className:'phalanx-market-actions'},expert.status!=='available'?h(Button,{variant:'outline',size:'sm',className:'phalanx-market-action',disabled:!services||busy!==undefined||launching!==undefined||data.pending,onClick:()=>void start(expert.id)},text('Start conversation')):null,
   h(Button,{variant:'outline',size:'sm',className:'phalanx-market-action',disabled:busy!==undefined||launching!==undefined||expert.status==='granted',onClick:()=>void resource.save(expert.id,expert.status==='summoned'?'dismiss':'summon')},text(expert.status==='granted'?'Owned expert':expert.status==='summoned'?'Dismiss expert':'Summon expert')))
  )))
 );
}
`
