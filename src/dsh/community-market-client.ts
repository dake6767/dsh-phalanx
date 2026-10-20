import { nativeExpertsTab } from './community-market-experts-client.js'
import { nativeMcpTab } from './community-market-mcp-client.js'
import { nativeMarketHelpers } from './community-market-shared-client.js'
import { nativeSkillsTab } from './community-market-skills-client.js'
import { nativePacksTab } from './community-market-packs-client.js'
import { nativePluginsTab } from './community-market-plugins-client.js'
import { platformMessages, platformErrorMessages, type PlatformMessageKey } from '../domain/platform-copy.js'

const keys = ['Start conversation','Host default model','Experts','No experts yet','Expert plugins','Expert skills','Expert skill packs','Example tasks (optional, 2–3 lines)','Published expert','Unpublished expert','Publish expert','Unpublish expert','Publish expert {name}','Unpublish expert {name}','Reload experts','Summon expert','Dismiss expert','Owned expert','Summoning gives you access to all expert entries and platform credentials throughout your instance, including entries not granted separately.','Dismissing an expert immediately withdraws its exclusive access. After restarting, its sessions cannot continue; history is retained.','Experts granted by your group cannot be dismissed.','Included entries','Example tasks',"Contributed by {name}", "Contributed anonymously", "MCP services", "MCP tools", "MCP services take effect immediately.", "Reload MCP services", "Granted MCP services", "Available MCP services", "Required by your administrator. You cannot disable this service.", "View MCP tools for {name}", "Enable MCP service {name}", "Close MCP tools", "No MCP services yet", "Reload skill packs", "Skill files", "Skill selections apply to new sessions without restarting your instance.", "Reload skills", "Skill synchronization is incomplete. Ask an administrator to retry synchronization.", "No published skills", "Overridden by your own skill with the same name", "Installed (self-selected skill)", "Uninstall self-selected skills here. Your own skill files are unchanged.", "View skill {name}", "Skill details", "Close skill details", "Pack changes apply to new sessions without restarting instances.", "No published skill packs", "Installed (self-selected pack)", "View skill pack {name}", "Skill pack details", "Close skill pack details", "Orchestration instructions (optional)", 'Plugins', 'Skills', 'Skill packs', 'Platform apps', 'Platform apps are loaded read-only after you restart your instance.', 'Reload plugins', 'Plugin installed.', 'Plugin updated. Restart your instance to apply the new version.', 'Restart DSH instance', 'Loading…', 'No published plugins', 'Version', 'Installing…', 'Installed', 'Update available', 'Install', 'Request failed', 'All plugins', 'Selection saved.', 'Changes take effect after restarting your instance.', 'Installed (platform preinstalled)', 'Installed (platform app center)', 'Installed on the native plugin page', 'Not installed', 'Uninstall on the native plugin page before selecting this platform app.', 'Uninstall', 'Saving…'] satisfies PlatformMessageKey[]
const copy = Object.fromEntries(['en', 'zh-CN'].map(locale => [locale, Object.fromEntries(keys.map(key => [key, platformMessages[locale as 'en' | 'zh-CN'][key]]))]))

/** Own presentation only. DSH supplies the public primitives and live semantic tokens. */
export const nativeMarketCss = `
.phalanx-market{display:flex;flex-direction:column;align-items:center;gap:32px;box-sizing:border-box;height:100%;overflow:auto;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary)}
.phalanx-market>*{width:100%;max-width:960px;min-width:0}
.phalanx-market-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px}
.phalanx-market h1{margin:0;font-size:20px;line-height:28px;font-weight:500}
.phalanx-market-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.phalanx-market-refresh{flex:none}
.phalanx-market-tab-content{display:flex;flex-direction:column;gap:20px}
.phalanx-market-tab-content .phalanx-market-head{padding-top:0}
.phalanx-market-group{display:flex;flex-direction:column;gap:8px}
.phalanx-market-group-head{display:flex;align-items:baseline;gap:8px}
.phalanx-market h2{margin:0;font-size:14px;line-height:22px;font-weight:500}
.phalanx-market-count{font-size:14px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.phalanx-market-list{display:flex;flex-direction:column;gap:2px;list-style:none;padding:0;margin:0}
.phalanx-market-row{display:flex;align-items:center;gap:14px;padding:8px 0;min-width:0}
.phalanx-market-icon{display:grid;place-items:center;flex:none;width:48px;height:48px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-secondary)}
.phalanx-market-main{flex:1;min-width:0}
.phalanx-market-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.phalanx-market h3{margin:0;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.phalanx-market-description{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.phalanx-market-action{flex:none}
.phalanx-market-actions{display:flex;flex-wrap:wrap;gap:8px}
.phalanx-market-modal{max-height:75vh;overflow:auto}
.phalanx-market-detail{min-width:0;overflow-wrap:anywhere}
.phalanx-market-status{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.phalanx-market-error{color:var(--dsw-alias-state-error-primary)}
.phalanx-market-copy-toggle{display:flex;align-items:center;gap:8px}
.phalanx-market-notice{display:flex;flex-direction:column;gap:8px}
.phalanx-market-notice a{color:var(--dsw-alias-link)}
@media(max-width:600px){.phalanx-market-row{display:grid;grid-template-columns:48px minmax(0,1fr)}.phalanx-market-action{grid-column:2;justify-self:start}.phalanx-market-row:not(:has(.phalanx-market-icon)){display:flex;align-items:flex-start;flex-direction:column}}
`

/** Runs inside DSH's official closure factory; never imports a feature's private implementation. */
export const nativeMarketComponent = `
const marketCopy=${JSON.stringify(copy)};
const marketErrors=${JSON.stringify(platformErrorMessages)};
${nativeMarketHelpers}
const marketTabs={};
isolated(()=>{
 ${nativePluginsTab}
 marketTabs.plugins=PluginsPanel;
});
isolated(()=>{${nativeSkillsTab}
marketTabs.skills=SkillsPanel;});
isolated(()=>{${nativePacksTab}
marketTabs.packs=PacksPanel;});
isolated(()=>{${nativeMcpTab}
marketTabs.mcp=McpPanel;});
isolated(()=>{${nativeExpertsTab}
marketTabs.experts=ExpertsPanel;});
function MarketPanel(){
 const locale=React.useSyncExternalStore(subscribe,snapshot)==='zh'?'zh-CN':'en';
 const text=key=>marketCopy[locale][key]||key;
 const [selected,setSelected]=React.useState('plugins');
 const items=[['plugins','Plugins'],['skills','Skills'],['packs','Skill packs'],['mcp','MCP services'],['experts','Experts']].map(([value,label])=>({value,label:text(label),id:'phalanx-tab-'+value,panelId:'phalanx-panel-'+value}));
 const Tab=marketTabs[selected]||UnavailableMarket;
 return h('section',{className:'phalanx-market','aria-label':text('Platform apps')},
  h('header',{className:'phalanx-market-head'},h('h1',null,text('Platform apps'))),
  h(SegmentedTabs,{items,value:selected,onChange:setSelected,label:text('Platform apps')}),
  h('div',{id:'phalanx-panel-'+selected,role:'tabpanel','aria-labelledby':'phalanx-tab-'+selected},h(ModuleBoundary,{key:selected,fallback:h(UnavailableMarket)},h(Tab)))
 );
}
`
