/** Expert cards use the same public native controls and isolated resource lifecycle as other tabs. */
export const nativeExpertsTab = `
// Launch dependencies activate locally, independently of other market tabs.
const expertLaunchListeners=new Set();let expertLaunchServices;
const expertLaunchSubscribe=listener=>{expertLaunchListeners.add(listener);return()=>expertLaunchListeners.delete(listener)};
const expertLaunchSnapshot=()=>expertLaunchServices;
ctx.inject(['sessions','workspaces','uiWorkspace','remote','remote.session'],scope=>{
 scope.effect(()=>{
  expertLaunchServices={sessions:scope.sessions,workspaces:scope.workspaces,uiWorkspace:scope.uiWorkspace,remote:scope.remote};
  for(const listener of expertLaunchListeners)listener();
  return()=>{expertLaunchServices=undefined;for(const listener of expertLaunchListeners)listener()};
 });
});
function ExpertsPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource('/market/api/experts');const {data,error,busy}=resource;
 const services=React.useSyncExternalStore(expertLaunchSubscribe,expertLaunchSnapshot);
 const [launchError,setLaunchError]=React.useState();const [launching,setLaunching]=React.useState();const launchPending=React.useRef(false);
 async function start(id){
  if(!services||launchPending.current)return;launchPending.current=true;setLaunching(id);setLaunchError(undefined);
  try{
   const plan=await marketRequest('/market/api/experts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:id,action:'start'})});
   const workspace=services.workspaces.list.getSnapshot().items[0]||await services.workspaces.initializeDefault();
   if(!workspace)throw {code:'expert-unavailable'};
   const sessionId=await services.sessions.create({workspaceId:workspace.workspaceId,agentPreset:plan.agentPreset});
   if(plan.model){const result=await services.remote.session.selectModel({sessionId,...plan.model});if(!result.ok)throw {error:text('Request failed')}}
   services.uiWorkspace.openSession(sessionId);
  }catch(failure){setLaunchError(failure)}finally{launchPending.current=false;setLaunching(undefined)}
 }
 return h('section',{className:'phalanx-market-tab-content','aria-label':text('Experts')},
  h('header',{className:'phalanx-market-head'},h('h2',null,text('Experts')),h(Button,{variant:'ghost',size:'sm',onClick:resource.reload},text('Reload experts'))),
  h('p',{className:'phalanx-market-intro'},text('Summoning gives you access to all expert entries and platform credentials throughout your instance, including entries not granted separately.')),
  h('p',{className:'phalanx-market-intro'},text('Dismissing an expert immediately withdraws its exclusive access. After restarting, its sessions cannot continue; history is retained.')),
  data?.pending?h('div',{className:'phalanx-market-notice',role:'status'},h('p',null,text('Changes take effect after restarting your instance.')),h('a',{href:'/recovery?restart=1'},text('Restart DSH instance'))):null,
  h(MarketFailure,{error:launchError||error,locale}),!data?h('p',{role:'status'},text('Loading…')):!data.experts.length?h('p',null,text('No experts yet')):
  h('ul',{className:'phalanx-market-list'},data.experts.map(expert=>h('li',{key:expert.id,className:'phalanx-market-row'},
   h('span',{className:'phalanx-market-icon','aria-hidden':true},expert.icon||'✦'),
   h('div',{className:'phalanx-market-main'},h('h3',null,expert.name),h('p',{className:'phalanx-market-description'},expert.description),
    h('p',{className:'phalanx-market-description'},expert.modelLabel||text('Host default model')),

    expert.checking?h('p',{className:'phalanx-market-status'},text('Checking capabilities…')):null,
    expert.partial?h('p',{className:'phalanx-market-status'},text('Some capabilities are temporarily unavailable.')):null,
    expert.examples.length?h('section',{'aria-label':text('Example tasks')},h('h4',null,text('Example tasks')),h('ul',null,expert.examples.map(example=>h('li',{key:example},example)))):null,
    h('section',{'aria-label':text('Included entries')},h('h4',null,text('Included entries')),h('ul',null,[['Expert plugins',expert.plugins],['Expert skills',expert.skills],['Expert skill packs',expert.skillPacks],['MCP services',expert.mcp]].flatMap(([kind,names])=>names.map(name=>h('li',{key:kind+':'+name},text(kind)+': '+name))))),
    expert.status==='granted'?h('p',{className:'phalanx-market-status'},text('Experts granted by your group cannot be dismissed.')):null),
   expert.status!=='available'?h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-action',disabled:!services||busy!==undefined||launching!==undefined||data.pending,onClick:()=>void start(expert.id)},text('Start conversation')):null,
   h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-action',disabled:busy!==undefined||launching!==undefined||expert.status==='granted',onClick:()=>void resource.save(expert.id,expert.status==='summoned'?'dismiss':'summon')},text(expert.status==='granted'?'Owned expert':expert.status==='summoned'?'Dismiss expert':'Summon expert'))
  )))
 );
}
`
