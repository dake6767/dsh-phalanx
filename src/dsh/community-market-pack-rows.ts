/** Request-free pack presentation shared by independently isolated native tabs. */
export const nativePackRows = `
function MarketPackRows({packs,resource,locale,renderSkill}){
 const text=marketText(locale);const [expanded,setExpanded]=React.useState([]);const [selected,setSelected]=React.useState();
 const id=React.useId();const detail=packs.find(pack=>pack.name===selected);
 return h(React.Fragment,null,h('ul',{className:'phalanx-market-list'},packs.map((pack,index)=>{
  const open=expanded.includes(pack.name);const contents=id+'-'+index;
  return h('li',{key:pack.name,className:'phalanx-market-row'},
   h('div',{className:'phalanx-market-main'},h('h3',null,pack.name),h('p',{className:'phalanx-market-description'},pack.description),h('p',{className:'phalanx-market-status'},text(pack.source==='managed'?'Installed (platform preinstalled)':pack.source==='selected'?'Installed (self-selected pack)':'Not installed')),
    h(Button,{variant:'ghost',size:'sm','aria-expanded':open,'aria-controls':open?contents:undefined,'aria-label':text(open?'Collapse skill pack {name}':'Expand skill pack {name}',{name:pack.name}),onClick:()=>setExpanded(values=>open?values.filter(name=>name!==pack.name):[...values,pack.name])},text(open?'Collapse skills':'Expand skills')),
    open?h('ul',{id:contents,className:'phalanx-market-list'},pack.skills.map(name=>renderSkill?renderSkill(name):h('li',{key:name},name))):null),
   h('div',{className:'phalanx-market-actions'},h(Button,{variant:'ghost',size:'sm','aria-label':text('View skill pack {name}',{name:pack.name}),onClick:()=>setSelected(pack.name)},text('Skill pack details')),
    h(Button,{variant:'outline',size:'sm',disabled:resource.busy!==undefined||pack.source==='managed',onClick:()=>void resource.save(pack.name,pack.source==='selected'?'uninstall':'install','/market/api/skill-packs')},text(resource.busy===pack.name?'Saving…':pack.source==='managed'?'Installed':pack.source==='selected'?'Uninstall':'Install')))
  );
 })),detail?h(Modal,{open:true,title:detail.name,closeLabel:text('Close skill pack details'),onClose:()=>setSelected(undefined),contentClassName:'phalanx-market-modal'},h('p',null,detail.description),h('ol',null,detail.skills.map(name=>h('li',{key:name},name))),detail.instructions?h(MarketContent,{markdown:detail.instructions,locale,title:text('Orchestration instructions (optional)')}):null):null);
}
`
