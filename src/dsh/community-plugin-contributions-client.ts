import { nativeMarketHelpers } from './community-market-shared-client.js'

/** Public plugins.detail.* owner props and UiWorkspace draft initialization. */
export const nativePluginContributions = `
 isolated(()=>ctx.inject(['uiWorkspace','workspaces','sessions'],injected=>{
  const ctx=injected;
  const marketCopy={'en-US':{},'zh-CN':{}},marketErrors={'en-US':{},'zh-CN':{}};
  ${nativeMarketHelpers}
  function usePluginContribution(subject){
   React.useSyncExternalStore(subscribe,snapshot);
   const locale=ctx.locale.getSnapshot().active==='zh'?'zh-CN':'en-US',resource=useMarketResource('/market/api/contributions');
   const pkg=subject.kind==='bundle'||subject.kind==='row'?subject.pkg:undefined;
   const eligible=pkg?.installed&&!pkg.official&&pkg.name!==${JSON.stringify('@dsh-phalanx/platform-plugin')};
   const rows=eligible?resource.data?.contributions.filter(row=>row.kind==='plugin'&&row.name===pkg.name)||[]:[];
   rows.sort((a,b)=>b.updatedAt-a.updatedAt);
   return {locale,resource,pkg,eligible,row:rows[0]};
  }
  const status=(row,zh)=>({pending:zh?'待处理':'Pending',adopted:zh?'已采纳':'Adopted',declined:zh?'未采纳':'Not adopted',withdrawn:zh?'已撤回':'Withdrawn'}[row.status]);
  function ContributionBadge({subject}){const {row,locale}=usePluginContribution(subject);return row?h(Tag,null,status(row,locale==='zh-CN')):null}
  function ContributionSection({subject}){
   const {row,locale,resource}=usePluginContribution(subject),[busy,setBusy]=React.useState(false),[error,setError]=React.useState();const zh=locale==='zh-CN';
   if(!row)return null;
   const withdraw=async()=>{setBusy(true);try{await marketRequest('/market/api/contributions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'withdraw',id:row.id})});resource.reload()}catch(failure){setError(failure)}finally{setBusy(false)}};
   return h('section',{'aria-label':zh?'插件贡献':'Plugin contribution',className:'phalanx-market-section'},h('h3',null,zh?'插件贡献':'Plugin contribution'),h('p',null,status(row,zh)+' · '+new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(row.submittedAt)),row.reason?h('p',null,row.reason):null,h(MarketFailure,{locale,error:error||resource.error}),row.status==='pending'?h(Button,{variant:'outline',size:'sm',disabled:busy,onClick:()=>void withdraw()},zh?'撤回贡献':'Withdraw contribution'):null);
  }
  function ContributionAction({subject}){
   const {pkg,eligible,locale}=usePluginContribution(subject),[busy,setBusy]=React.useState(false),[error,setError]=React.useState();if(!eligible)return null;
   const zh=locale==='zh-CN';
   const prompt=zh?'请检查我安装的插件 '+pkg.name+'（版本 '+(pkg.version||'未知')+'）的源文件、package.json、bundle patch 和声明。定位本机安装目录，确认不含凭据并声明所需平台上游和环境变量，然后使用 submit_contribution（kind plugin）准备贡献。提交前必须让我在确认卡片中点击提交。':'Inspect my installed plugin '+pkg.name+' (version '+(pkg.version||'unknown')+'), its source, package.json, bundle patch and declaration. Locate its local directory, check for credentials and declare required platform upstreams and environment variables, then prepare a contribution with submit_contribution (kind plugin). I must click Submit on the confirmation card before upload.';
   const start=async()=>{setBusy(true);setError(undefined);try{const workspaces=ctx.workspaces.list.getSnapshot(),sessions=ctx.sessions.list.getSnapshot(),hasSession=workspaces.items.some(workspace=>workspace.sessionIds.some(id=>sessions.byId[id]));if(hasSession)ctx.uiWorkspace.startSession(undefined,{prompt});else{const workspace=workspaces.items[0]||await ctx.workspaces.initializeDefault();if(!workspace)throw new Error('Workspace unavailable');ctx.uiWorkspace.startSession(workspace.workspaceId,{prompt})}}catch{setError({error:zh?'无法打开贡献会话，请选择工作区后重试。':'Unable to open a contribution session. Choose a workspace and retry.'})}finally{setBusy(false)}};
   return h(React.Fragment,null,h(Button,{variant:'outline',size:'sm',disabled:busy,onClick:()=>void start()},zh?'贡献到平台':'Contribute to platform'),h(MarketFailure,{locale,error}));
  }
  slot('plugins.detail.badge',()=>ctx.slots.register({name:'plugins.detail.badge',id:'phalanx-plugin-contribution-badge'},ContributionBadge));
  slot('plugins.detail.section',()=>ctx.slots.register({name:'plugins.detail.section',id:'phalanx-plugin-contribution-section'},ContributionSection));
  slot('plugins.detail.actions',()=>ctx.slots.register({name:'plugins.detail.actions',id:'phalanx-plugin-contribution-action'},ContributionAction));
 }));
`
