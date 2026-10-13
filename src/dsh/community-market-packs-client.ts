/** Pack tab has its own resource lifecycle and fault boundary. */
export const nativePacksTab = `
const packsPath='/market/api/skill-packs';
function PacksPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource(packsPath);const {data,error,busy}=resource;const packs=data;
 const [selected,setSelected]=React.useState();const detail=packs?.find(pack=>pack.name===selected);
 return h('section',{className:'phalanx-market-tab-content','aria-label':text('Skill packs')},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('Skill packs')),h('p',{className:'phalanx-market-intro'},text('Pack changes apply to new sessions without restarting instances.'))),h(Button,{variant:'ghost',size:'sm',onClick:resource.reload},text('Reload skill packs'))),
  h(MarketFailure,{error,locale}),!packs?h('p',{role:'status'},text('Loading…')):!packs.length?h('p',null,text('No published skill packs')):h('ul',{className:'phalanx-market-list'},packs.map(pack=>h('li',{key:pack.name,className:'phalanx-market-row'},
   h('div',{className:'phalanx-market-main'},h('h3',null,pack.name),h('p',{className:'phalanx-market-description'},pack.description),h('p',{className:'phalanx-market-status'},text(pack.source==='managed'?'Installed (platform preinstalled)':pack.source==='selected'?'Installed (self-selected pack)':'Not installed')),h('div',{className:'phalanx-market-actions'},pack.skills.map(name=>h(Tag,{key:name,tone:'quiet'},name)))),
   h('div',{className:'phalanx-market-actions'},h(Button,{variant:'ghost',size:'sm','aria-label':text('View skill pack {name}',{name:pack.name}),onClick:()=>setSelected(pack.name)},text('Skill pack details')),
    h(Button,{variant:'outline',size:'sm',disabled:busy!==undefined||pack.source==='managed',onClick:()=>void resource.save(pack.name,pack.source==='selected'?'uninstall':'install')},text(busy===pack.name?'Saving…':pack.source==='managed'?'Installed':pack.source==='selected'?'Uninstall':'Install')))
  ))),
  detail?h(Modal,{open:true,title:detail.name,closeLabel:text('Close skill pack details'),onClose:()=>setSelected(undefined),contentClassName:'phalanx-market-modal'},h('p',null,detail.description),h('ol',null,detail.skills.map(name=>h('li',{key:name},name))),detail.instructions?h(MarketContent,{markdown:detail.instructions,locale,title:text('Orchestration instructions (optional)')}):null):null
 );
}
`
