import { nativeContributionsPanel } from './community-contributions-client.js'
/** Skill tab initializes and renders independently of the other app-center tabs. */
export const nativeSkillsTab = `
${nativeContributionsPanel}
const skillsPath='/market/api/skills';
function SkillsPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource(skillsPath);const {data,error,busy,revision}=resource;
 const [selected,setSelected]=React.useState();const [detail,setDetail]=React.useState();const [detailError,setDetailError]=React.useState();
 React.useEffect(()=>{if(data)setSelected(current=>data.skills.some(row=>row.name===current)?current:undefined)},[data]);
 React.useEffect(()=>{
  const controller=new AbortController();setDetail(undefined);setDetailError(undefined);
  if(selected)void marketRequest(skillsPath+'/detail?name='+encodeURIComponent(selected),{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setDetail(value)}).catch(failure=>{if(!controller.signal.aborted)setDetailError(failure)});
  return()=>controller.abort();
 },[selected,revision]);
 return h('section',{className:'phalanx-market-tab-content','aria-label':text('Skills')},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('Skills')),h('p',{className:'phalanx-market-intro'},text('Skill selections apply to new sessions without restarting your instance.'))),h(Button,{variant:'ghost',size:'sm',onClick:resource.reload},text('Reload skills'))),
  h(MarketFailure,{error,locale}),data?.pending?h('p',{role:'status'},text('Skill synchronization is incomplete. Ask an administrator to retry synchronization.')):null,
  !data?h('p',{role:'status'},text('Loading…')):!data.skills.length?h('p',null,text('No published skills')):h('ul',{className:'phalanx-market-list'},data.skills.map(skill=>h('li',{key:skill.name,className:'phalanx-market-row'},
   h('div',{className:'phalanx-market-main'},h('h3',null,skill.name),h('p',{className:'phalanx-market-description'},skill.description),skill.contribution?h('p',{className:'phalanx-market-description'},text(skill.contribution.anonymous?'Contributed anonymously':'Contributed by {name}',{name:skill.contribution.name})):null,
    h('p',{className:'phalanx-market-status'},text(skill.status==='overridden'?'Overridden by your own skill with the same name':skill.status==='managed'?'Installed (platform preinstalled)':skill.status==='selected'?'Installed (self-selected skill)':'Not installed')),
    skill.status==='overridden'&&skill.source==='managed'?h('p',{className:'phalanx-market-status'},text('Installed (platform preinstalled)')):null,
    h('p',{className:'phalanx-market-description'},text('Uninstall self-selected skills here. Your own skill files are unchanged.'))),
   h('div',{className:'phalanx-market-actions'},h(Button,{variant:'ghost',size:'sm','aria-label':text('View skill {name}',{name:skill.name}),onClick:()=>setSelected(skill.name)},text('Skill details')),
    h(Button,{variant:'outline',size:'sm',disabled:busy!==undefined||skill.selectable===false||skill.source==='managed',onClick:()=>void resource.save(skill.name,skill.selectedDirectly?'uninstall':'install')},text(busy===skill.name?'Saving…':skill.source==='managed'?'Installed':skill.selectedDirectly?'Uninstall':'Install')))
  ))),
  h(ContributionsPanel,{locale}),
  selected?h(Modal,{open:true,title:selected,closeLabel:text('Close skill details'),onClose:()=>setSelected(undefined),contentClassName:'phalanx-market-modal'},detailError?h(MarketFailure,{error:detailError,locale}):detail?h(React.Fragment,null,h('p',null,detail.description),detail.contribution?h('p',null,text(detail.contribution.anonymous?'Contributed anonymously':'Contributed by {name}',{name:detail.contribution.name})):null,h(MarketContent,{markdown:detail.markdown,files:detail.files,locale})):h('p',{role:'status'},text('Loading…'))):null
 );
}
`
