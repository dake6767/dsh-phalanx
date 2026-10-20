/** Expert cards use the same public native controls and isolated resource lifecycle as other tabs. */
export const nativeExpertsTab = `
function ExpertsPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource('/market/api/experts');const {data,error,busy}=resource;
 return h('section',{className:'phalanx-market-tab-content','aria-label':text('Experts')},
  h('header',{className:'phalanx-market-head'},h('h2',null,text('Experts')),h(Button,{variant:'ghost',size:'sm',onClick:resource.reload},text('Reload experts'))),
  h('p',{className:'phalanx-market-intro'},text('Summoning gives you access to all expert entries and platform credentials throughout your instance, including entries not granted separately.')),
  h('p',{className:'phalanx-market-intro'},text('Dismissing an expert immediately withdraws its exclusive access. After restarting, its sessions cannot continue; history is retained.')),
  data?.pending?h('div',{className:'phalanx-market-notice',role:'status'},h('p',null,text('Changes take effect after restarting your instance.')),h('a',{href:'/recovery?restart=1'},text('Restart DSH instance'))):null,
  h(MarketFailure,{error,locale}),!data?h('p',{role:'status'},text('Loading…')):!data.experts.length?h('p',null,text('No experts yet')):
  h('ul',{className:'phalanx-market-list'},data.experts.map(expert=>h('li',{key:expert.id,className:'phalanx-market-row'},
   h('span',{className:'phalanx-market-icon','aria-hidden':true},expert.icon||'✦'),
   h('div',{className:'phalanx-market-main'},h('h3',null,expert.name),h('p',{className:'phalanx-market-description'},expert.description),
    expert.examples.length?h('section',{'aria-label':text('Example tasks')},h('h4',null,text('Example tasks')),h('ul',null,expert.examples.map(example=>h('li',{key:example},example)))):null,
    h('section',{'aria-label':text('Included entries')},h('h4',null,text('Included entries')),h('ul',null,[['Expert plugins',expert.plugins],['Expert skills',expert.skills],['Expert skill packs',expert.skillPacks],['MCP services',expert.mcp]].flatMap(([kind,names])=>names.map(name=>h('li',{key:kind+':'+name},text(kind)+': '+name))))),
    expert.status==='granted'?h('p',{className:'phalanx-market-status'},text('Experts granted by your group cannot be dismissed.')):null),
   h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-action',disabled:busy!==undefined||expert.status==='granted',onClick:()=>void resource.save(expert.id,expert.status==='summoned'?'dismiss':'summon')},text(expert.status==='granted'?'Owned expert':expert.status==='summoned'?'Dismiss expert':'Summon expert'))
  )))
 );
}
`
