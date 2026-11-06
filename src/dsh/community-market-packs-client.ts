import { nativePackRows } from './community-market-pack-rows.js'
/** Pack tab has its own resource lifecycle and fault boundary. */
export const nativePacksTab = `
${nativePackRows}
const packsPath='/market/api/skill-packs';
function PacksPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource(packsPath);const {data,error}=resource;
 return h('section',{className:'phalanx-market-tab-content','aria-label':text('Skill packs')},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('Skill packs')),h('p',{className:'phalanx-market-intro'},text('Pack changes apply to new sessions without restarting instances.'))),h(Button,{variant:'ghost',size:'sm',onClick:resource.reload},text('Reload skill packs'))),
  h(MarketFailure,{error,locale}),!data?h('p',{role:'status'},text('Loading…')):!data.length?h('p',null,text('No published skill packs')):h(MarketPackRows,{packs:data,resource,locale})
 );
}
`
