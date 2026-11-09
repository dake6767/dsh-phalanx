import { featureVisible } from '../domain/release-visibility.js'
import { nativePackRows } from './community-market-pack-rows.js'
import { nativeContributionsPanel } from './community-contributions-client.js'
/** Skill tab initializes and renders independently of the other app-center tabs. */
export const nativeSkillsTab = `
${featureVisible('contributions') ? nativeContributionsPanel : ''}
${nativePackRows}
const skillsPath='/market/api/skills';
function SkillsPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource(skillsPath);const {data,error,busy,revision}=resource;
 const [selected,setSelected]=React.useState();const [detail,setDetail]=React.useState();const [detailError,setDetailError]=React.useState();
 React.useEffect(()=>{if(data)setSelected(current=>data.skills.some(row=>row.name===current&&row.detailsAvailable)?current:undefined)},[data]);
 React.useEffect(()=>{
  const controller=new AbortController();setDetail(undefined);setDetailError(undefined);
  if(selected)void marketRequest(skillsPath+'/detail?name='+encodeURIComponent(selected),{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setDetail(value)}).catch(failure=>{if(!controller.signal.aborted)setDetailError(failure)});
  return()=>controller.abort();
 },[selected,revision]);
 const skillRow=skill=>h('li',{key:skill.name,className:'phalanx-market-row'},
   h('div',{className:'phalanx-market-main'},h('h3',null,skill.name),h('p',{className:'phalanx-market-description'},skill.description),${featureVisible('contributions')}&&skill.contribution?h('p',{className:'phalanx-market-description'},text(skill.contribution.anonymous?'Contributed anonymously':'Contributed by {name}',{name:skill.contribution.name})):null,
    h('p',{className:'phalanx-market-status'},text(skill.status==='overridden'?'Overridden by your own skill with the same name':skill.status==='managed'?'Installed (platform preinstalled)':skill.status==='selected'?'Installed (self-selected skill)':'Not installed')),
    skill.status==='overridden'&&skill.source==='managed'?h('p',{className:'phalanx-market-status'},text('Installed (platform preinstalled)')):null),
   h('div',{className:'phalanx-market-actions'},skill.detailsAvailable?h(Button,{variant:'outline',size:'sm','aria-label':text('View skill {name}',{name:skill.name}),onClick:()=>setSelected(skill.name)},text('Skill details')):null,
    h(Button,{variant:'outline',size:'sm',disabled:busy!==undefined||skill.selectable===false||skill.source==='managed',onClick:()=>void resource.save(skill.name,skill.selectedDirectly?'uninstall':'install')},text(busy===skill.name?'Saving…':skill.source==='managed'?'Installed':skill.selectedDirectly?'Uninstall':'Install')))
);
 return h('section',{className:'phalanx-market-tab-content phalanx-market-structured','aria-label':text('Skills')},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('Skills')),h('p',{className:'phalanx-market-intro'},text('Skill selections apply to new sessions without restarting your instance.')),h('p',{className:'phalanx-market-intro'},text('Uninstall self-selected skills here. Your own skill files are unchanged.'))),h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-refresh',onClick:resource.reload,title:text('Reload skills'),'aria-label':text('Reload skills'),icon:h(IconRefreshOutlineRegular,{size:16})})),
  h(MarketFailure,{error,locale}),data?.pending?h('p',{role:'status'},text('Skill synchronization is incomplete. Ask an administrator to retry synchronization.')):null,
  !data?h('p',{role:'status'},text('Loading…')):!data.skills.length&&!data.packs.length?h('p',null,text('No published skills')):h(React.Fragment,null,
   data.packs.length?h('section',{className:'phalanx-market-group','aria-label':text('Skill packs')},h('h2',null,text('Skill packs')),
    h(MarketPackRows,{packs:data.packs,resource,locale,renderSkill:name=>{const skill=data.skills.find(row=>row.name===name);return skill?skillRow(skill):null}})):null,
   data.skills.some(skill=>skill.topLevel)?h('ul',{className:'phalanx-market-list','aria-label':text('Skills')},data.skills.filter(skill=>skill.topLevel).map(skillRow)):null),
  ${featureVisible('contributions') ? 'h(ContributionsPanel,{locale}),' : ''}
  selected?h(Modal,{open:true,title:selected,description:detail?.description,closeLabel:text('Close skill details'),onClose:()=>setSelected(undefined),className:'phalanx-market-dialog',contentClassName:'phalanx-market-modal phalanx-market-dialog-content'},detailError?h(MarketFailure,{error:detailError,locale}):detail?h('div',{className:'phalanx-market-detail-body'},${featureVisible('contributions')}&&detail.contribution?h('p',{className:'phalanx-market-status'},text(detail.contribution.anonymous?'Contributed anonymously':'Contributed by {name}',{name:detail.contribution.name})):null,h(MarketContent,{markdown:detail.markdown,files:detail.files,locale})):h('p',{role:'status'},text('Loading…'))):null
 );
}
`
