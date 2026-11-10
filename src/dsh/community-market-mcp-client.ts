import { mcpDisplayText } from '../domain/mcp-display.js'
/** MCP uses only frozen public native primitives, with a separate failure boundary. */
export const nativeMcpTab = `
const mcpDisplayText=${mcpDisplayText.toString()};
function McpPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';const text=marketText(locale);
 const resource=useMarketResource('/market/api/mcp');const {data,error,busy}=resource;
 const [selected,setSelected]=React.useState();const detail=data?.find(service=>service.name===selected);
 const presentation=service=>mcpDisplayText(service,locale);
 const duplicate=service=>data.filter(row=>presentation(row).name===presentation(service).name).length>1;
 return h('section',{className:'phalanx-market-tab-content phalanx-market-structured','aria-label':text('MCP services')},
  h('header',{className:'phalanx-market-head'},h('div',null,h('h2',null,text('MCP services')),h('p',{className:'phalanx-market-intro'},text('MCP services take effect immediately.'))),h(Button,{variant:'ghost',size:'sm',className:'phalanx-market-refresh',onClick:resource.reload,title:text('Reload MCP services'),'aria-label':text('Reload MCP services'),icon:h(IconRefreshOutlineRegular,{size:16})})),
  h(MarketFailure,{error,locale}),!data?h('p',{role:'status'},text('Loading…')):
  [true,false].map(granted=>{const rows=data.filter(service=>service.granted===granted);const label=text(granted?'Granted MCP services':'Available MCP services');return h('section',{key:String(granted),className:'phalanx-market-group','aria-label':label},
   h('div',{className:'phalanx-market-group-head'},h('h2',null,label),h('span',{className:'phalanx-market-count'},rows.length)),
   !rows.length?h('p',{className:'phalanx-market-status'},text('No MCP services yet')):h('ul',{className:'phalanx-market-list'},rows.map(service=>h('li',{key:service.name,className:'phalanx-market-row'},
    h('div',{className:'phalanx-market-main'},h('h3',null,presentation(service).name),duplicate(service)?h('p',{className:'phalanx-market-status'},service.name):null,h('p',{className:'phalanx-market-description'},presentation(service).description),service.required?h('p',{className:'phalanx-market-status'},text('Required by your administrator. You cannot disable this service.')):null),
    h('div',{className:'phalanx-market-actions'},h(Button,{variant:'outline',size:'sm','aria-label':text('View MCP tools for {name}',{name:service.name}),onClick:()=>setSelected(service.name)},text('MCP tools')),
     h(Switch,{checked:service.enabled,disabled:busy!==undefined||service.required,
      label:text('Enable MCP service {name}',{name:service.name}),
      title:service.required?text('Required by your administrator. You cannot disable this service.'):undefined,
      onChange:enabled=>void resource.save(service.name,enabled?'enable':'disable')}))
   )))
  )}),
  detail?h(Modal,{open:true,title:presentation(detail).name,description:presentation(detail).description,closeLabel:text('Close MCP tools'),onClose:()=>setSelected(undefined),className:'phalanx-market-dialog',contentClassName:'phalanx-market-modal phalanx-market-dialog-content'},h('p',{className:'phalanx-market-status'},text('Service identifier')+': '+detail.name),h('ul',{className:'phalanx-market-tool-list'},detail.tools.map(tool=>h('li',{key:tool.name},h('strong',null,tool.name),tool.description?h('p',{className:'phalanx-market-description'},tool.description):null)))):null
 );
}
`
