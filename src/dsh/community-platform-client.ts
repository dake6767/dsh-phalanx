import { PLATFORM_ACCOUNT_SYNC_SCRIPT } from '../domain/platform-account-sync.js'
import { featureVisible } from '../domain/release-visibility.js'
import { nativeAccountSwitchClient, nativeAccountSwitchCss } from './community-account-switch-client.js'
import { nativePluginContributions } from './community-plugin-contributions-client.js'
import { htmlPreviewClient } from './community-html-preview.js'
import { artifactDownloadClient } from './community-artifact-client.js'
import { nativeMarketCss, nativeMarketComponent } from './community-market-client.js'

/** Official closure-factory client artifact; React and native primitives share DSH's module table. */
export const platformClientName = '@dsh-phalanx/platform-plugin'
export const platformPluginManifest = JSON.stringify({
  name: platformClientName,
  version: '0.1.14',
  type: 'module',
  main: './plugin.mjs',
  exports: { '.': './plugin.mjs', './client': './client.js' },
  dsh: {
    client: {
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-sidebar',
        '@deepseek-ai/dsh-client-ui-settings-general',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-plugin-manager',
        '@deepseek-ai/dsh-client-ui-workspace',
      ],
    },
  },
})
// The pinned DSH Web feedback form can also be opened without native account diagnostics.
const feedbackForm = 'https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'

export const platformPluginClient = `window.__ModuleLoader__.load({id:${JSON.stringify(platformClientName)},factory:require=>{
 try {
 ${PLATFORM_ACCOUNT_SYNC_SCRIPT}
 const React=require('react');const {Menu,Button,Switch,Tag,SegmentedTabs,Modal,MarkdownText,IconRefreshOutlineRegular,IconPluginPinwheelOutlineRegular,IconSettingsOutlineMedium,IconPaperPlaneOutlineMedium,IconUserOutlineMedium}=require('@deepseek-ai/dsh-client-ui-primitives');const h=React.createElement;
 const css='.phalanx-account-launcher{display:flex;align-items:center;width:100%;min-width:0;gap:4px}.phalanx-account-launcher[data-wide=false]{flex-direction:column}.phalanx-account-menu{display:block;flex:1;min-width:0}.phalanx-account-launcher .phalanx-settings-trigger{width:36px;padding:0}.phalanx-settings-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.phalanx-account-trigger{box-sizing:border-box;display:flex;align-items:center;gap:var(--dsh-sidebar-label-gap,6px);width:100%;min-width:0;min-height:42px;padding:7px calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px));border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}.phalanx-account-trigger:hover,.phalanx-account-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.phalanx-account-trigger:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}.phalanx-account-trigger[data-wide=false]{justify-content:center;padding:0;width:36px;height:36px;margin-inline:auto}.phalanx-account-avatar{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;font-weight:600}.phalanx-account-trigger .phalanx-account-avatar{width:28px;height:28px;border-radius:50%;corner-shape:round}.phalanx-account-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
 ${nativeAccountSwitchClient}
 class ModuleBoundary extends React.Component {
  constructor(props){super(props);this.state={failed:false}}
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed?(this.props.fallback||null):this.props.children}
 }
 function SafeAccount(props){return h(ModuleBoundary,null,h(Account,props))}
 function Account({wide,t,locale,openSettings}){
  const [username,setUsername]=React.useState('');const [admin,setAdmin]=React.useState(false);const [open,setOpen]=React.useState(false);const [gearOpen,setGearOpen]=React.useState(false);const [switching,setSwitching]=React.useState(false);const form=React.useRef(null);
  React.useEffect(()=>{const controller=new AbortController();fetch('/account/identity',{credentials:'same-origin',signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('Identity unavailable');const value=await response.json();if(typeof value.username==='string'&&value.username){setUsername(value.username);setAdmin(value.admin===true)}}).catch(()=>{});return()=>controller.abort()},[]);
  const label=username?t('account')+': '+username:t('account');
  const anchor=h('button',{type:'button',className:'phalanx-account-trigger','data-wide':wide,'aria-label':label,title:label,'aria-haspopup':'menu','aria-expanded':open,onClick:()=>setOpen(value=>!value)},h('span',{className:'phalanx-account-avatar','aria-hidden':true},h(IconUserOutlineMedium,{size:18})),wide?h('span',{className:'phalanx-account-name'},username||t('fallback')):null);
  const gear=h(Button,{type:'button',className:'phalanx-settings-trigger',variant:'ghost','aria-label':t('settingsMenu'),title:t('settingsMenu'),'aria-haspopup':'menu','aria-expanded':gearOpen,onClick:()=>setGearOpen(value=>!value)},h(IconSettingsOutlineMedium,{size:18}));
  return h('div',{className:'phalanx-account-launcher','data-wide':wide},h(Menu,{open,anchor,autoFocus:true,side:'top',portal:true,className:'phalanx-account-menu',items:[...(admin?[{id:'admin',label:t('admin')}]:[]),{id:'switch',label:t('switch')},{id:'restart',label:t('restart')},{id:'recovery',label:t('recovery')},{id:'logout',label:t('logout')}],onClose:()=>setOpen(false),onSelect:id=>{setOpen(false);if(id==='admin')window.open('/admin','_blank','noopener,noreferrer');else if(id==='switch')setSwitching(true);else if(id==='restart')location.assign('/recovery?restart=1');else if(id==='recovery')location.assign('/recovery');else if(id==='logout')form.current?.requestSubmit()}}),h(Menu,{open:gearOpen,anchor:gear,autoFocus:true,side:'top',align:'end',portal:true,
   items:[{id:'settings',label:t('settings'),icon:h(IconSettingsOutlineMedium,{size:16})},{id:'feedback',label:t('feedback'),icon:h(IconPaperPlaneOutlineMedium,{size:16})}],
   onClose:()=>setGearOpen(false),onSelect:id=>{setGearOpen(false);if(id==='settings')openSettings();else if(id==='feedback')window.open(${JSON.stringify(feedbackForm)},'_blank','noopener,noreferrer')}
  }),h('form',{ref:form,method:'post',action:'/logout',hidden:true}),h(AccountSwitchDialog,{locale,open:switching,onClose:()=>setSwitching(false)}));
 }
 return {name:'phalanx-platform-client',inject:['slots','locale'],apply(ctx){try {
  const namespace='phalanx-account';
  ctx.effect(()=>ctx.locale.register(namespace,{en:{admin:'Go to admin console',account:'Platform account',fallback:'Account',settingsMenu:'Settings menu',settings:'Settings',feedback:'Feedback',switch:'Switch accounts',restart:'Restart instance',recovery:'More recovery options',logout:'Log out',market:'Platform App Center',setup:'Plugin setup',unavailable:'Platform App Center is unavailable. Reload to try again.'},zh:{admin:'前往管理后台',account:'平台账户',fallback:'账户',settingsMenu:'设置菜单',settings:'设置',feedback:'意见反馈',switch:'切换账户',restart:'重启实例',recovery:'更多恢复选项',logout:'退出登录',market:'平台应用中心',setup:'插件设置状态',unavailable:'平台应用中心暂不可用，请刷新重试。'}}));
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin=${JSON.stringify(platformClientName)};style.textContent=css+${JSON.stringify(nativeAccountSwitchCss + nativeMarketCss)};document.head.appendChild(style);return()=>style.remove()});
  const t=ctx.locale.bind(namespace);
  const subscribe=listener=>ctx.locale.subscribe(listener);const snapshot=()=>ctx.locale.getSnapshot().active;
  // Each feature owns initialization and its delayed slot registration independently.
  const isolated=register=>{try{return register()}catch{console.warn('A platform module is unavailable')}};
  const slot=(name,register)=>isolated(()=>ctx.slots.inject(name,()=>isolated(register)));
  function NativeAccount(props){React.useSyncExternalStore(subscribe,snapshot);return h(SafeAccount,{...props,locale:snapshot()==='zh'?'zh-CN':'en'})}
  slot('settings.launcher',()=>ctx.slots.register({name:'settings.launcher',priority:-10,locale:namespace},NativeAccount));
  function UnavailableMarket(){React.useSyncExternalStore(subscribe,snapshot);return h('p',{role:'alert'},t('unavailable'))}
  let Market=UnavailableMarket, Setup=UnavailableMarket;
  isolated(()=>{
    ${nativeMarketComponent}
    Market=MarketPanel;
    Setup=SetupPanel;
  });
  ${featureVisible('contributions') ? nativePluginContributions : ''}
  ${artifactDownloadClient}
  ${htmlPreviewClient}
  function SafeSetup(){return h(ModuleBoundary,{fallback:h(UnavailableMarket)},h(Setup))}
  function SafeMarket(){return h(ModuleBoundary,{fallback:h(UnavailableMarket)},h(Market))}
  function MarketIcon({size=16,className}){
   return h('svg',{width:size,height:size,viewBox:'0 0 16 16',className,fill:'none',stroke:'currentColor',strokeWidth:1,'aria-hidden':true},
    h('rect',{x:2.25,y:2.25,width:4,height:4,rx:1}),
    h('rect',{x:9.75,y:2.25,width:4,height:4,rx:1}),
    h('rect',{x:2.25,y:9.75,width:4,height:4,rx:1}),
    h('rect',{x:9.75,y:9.75,width:4,height:4,rx:1}));
  }
  ctx.effect(()=>{
    const controller=new AbortController();
    let panel, entry;
    async function showMarket(){
      const response=await fetch('/account/platform-features',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if(!response.ok)return;
      const settings=await response.json();
      if(controller.signal.aborted)return;
      if(settings?.showAppCenter!==true){
        const setup=await fetch('/market/api/plugins/setup',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
        if(!setup.ok)return;
        const data=await setup.json();
        if(controller.signal.aborted || !data.nativeServices?.length && !data.preinstallFailures?.length)return;
        panel=slot('main',()=>ctx.slots.register({name:'main',key:'phalanx-plugin-setup',locale:namespace},SafeSetup));
        entry=slot('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'phalanx-plugin-setup',order:10,label:()=>t('setup'),locale:namespace},MarketIcon));
        return;
      }
      panel=slot('main',()=>ctx.slots.register({name:'main',key:'phalanx-market',locale:namespace},SafeMarket));
      entry=slot('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'phalanx-market',order:10,label:()=>t('market'),locale:namespace},MarketIcon));
    }
    void showMarket().catch(()=>{});
    return()=>{controller.abort();entry?.();panel?.()};
  });
 }catch { /* A platform action must not block the native UI. */ }} };
 }catch {return {name:'phalanx-platform-client',apply(){}}}
}});`
