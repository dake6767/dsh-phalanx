/** Official closure-factory client artifact; React and native primitives share DSH's module table. */
export const platformClientName = '@dsh-phalanx/platform-plugin'
export const platformPluginManifest = JSON.stringify({ name: platformClientName, version: '0.1.3', type: 'module', main: './plugin.mjs', exports: { '.': './plugin.mjs', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-sidebar'] } } })
export const platformPluginClient = `window.__ModuleLoader__.load({id:${JSON.stringify(platformClientName)},factory:require=>{
 try {
 const React=require('react');const {Menu}=require('@deepseek-ai/dsh-client-ui-primitives');const h=React.createElement;
 const css='.phalanx-account-menu{display:block;width:100%;min-width:0}.phalanx-account-trigger{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 4px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}.phalanx-account-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.phalanx-account-trigger:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.phalanx-account-avatar{display:grid;place-items:center;width:28px;height:28px;flex:none;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);font-weight:600}.phalanx-account-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
 class AccountBoundary extends React.Component {
  constructor(props){super(props);this.state={failed:false}}
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed?null:this.props.children}
 }
 function SafeAccount(props){return h(AccountBoundary,null,h(Account,props))}
 function Account({wide}){
  const [username,setUsername]=React.useState('');const [open,setOpen]=React.useState(false);const form=React.useRef(null);
  React.useEffect(()=>{const controller=new AbortController();fetch('/account/identity',{credentials:'same-origin',signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('Identity unavailable');const value=await response.json();if(typeof value.username==='string')setUsername(value.username)}).catch(()=>{});return()=>controller.abort()},[]);
  const label=username?'Platform account: '+username:'Platform account';
  const anchor=h('button',{type:'button',className:'phalanx-account-trigger','aria-label':label,title:label,'aria-haspopup':'menu','aria-expanded':open,onClick:()=>setOpen(value=>!value)},h('span',{className:'phalanx-account-avatar','aria-hidden':true},username?username.slice(0,1).toUpperCase():'·'),wide?h('span',{className:'phalanx-account-name'},username||'Account'):null);
  return h(React.Fragment,null,h(Menu,{open,anchor,autoFocus:true,side:'top',portal:true,className:'phalanx-account-menu',items:[{id:'restart',label:'Restart instance'},{id:'logout',label:'Log out'}],onClose:()=>setOpen(false),onSelect:id=>{setOpen(false);if(id==='restart')location.assign('/recovery?restart=1');else if(id==='logout')form.current?.requestSubmit()}}),h('form',{ref:form,method:'post',action:'/logout',hidden:true}));
 }
 return {name:'phalanx-platform-client',inject:['slots'],apply(ctx){try {
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin=${JSON.stringify(platformClientName)};style.textContent=css;document.head.appendChild(style);return()=>style.remove()});
  ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'phalanx-platform-account'},SafeAccount));
 }catch { /* A platform action must not block the native UI. */ }} };
 }catch {return {name:'phalanx-platform-client',apply(){}}}
}});`
