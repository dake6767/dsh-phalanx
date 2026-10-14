/** Member contribution state uses the existing authenticated platform session channel. */
export const nativeContributionsPanel = `
function ContributionsPanel({locale}){
 const zh=locale==='zh-CN',resource=useMarketResource('/market/api/contributions'),[busy,setBusy]=React.useState(false),[error,setError]=React.useState();
 async function withdraw(id){setBusy(true);try{await marketRequest('/market/api/contributions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'withdraw',id})});resource.reload()}catch(failure){setError(failure)}finally{setBusy(false)}}
 const labels=zh?{pending:'待处理',adopted:'已采纳',declined:'未采纳',withdrawn:'已撤回'}:{pending:'Pending',adopted:'Adopted',declined:'Not adopted',withdrawn:'Withdrawn'};
 return h('section',{'aria-label':zh?'我的贡献':'My contributions'},h('div',{className:'phalanx-market-head'},h('h2',null,zh?'我的贡献':'My contributions'),h(Button,{variant:'ghost',size:'sm',onClick:resource.reload},zh?'刷新贡献':'Reload contributions')),
 h(MarketFailure,{error:error||resource.error,locale}),!resource.data?h('p',{role:'status'},zh?'加载中…':'Loading…'):!resource.data.contributions.filter(row=>row.kind!=='plugin').length?h('p',null,zh?'暂无成员贡献':'No contributions yet'):h('ul',{className:'phalanx-market-list'},resource.data.contributions.filter(row=>row.kind!=='plugin').map(row=>h('li',{key:row.id,className:'phalanx-market-row'},h('div',{className:'phalanx-market-main'},h('h3',null,row.name),h('p',null,labels[row.status]+' · '+new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(row.submittedAt)),row.reason?h('p',null,row.reason):null),row.status==='pending'?h(Button,{variant:'outline',size:'sm',disabled:busy,onClick:()=>void withdraw(row.id)},zh?'撤回':'Withdraw'):null))));
}
`
