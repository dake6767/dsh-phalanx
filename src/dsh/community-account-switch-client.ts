import { platformMessages, type PlatformMessageKey } from '../domain/platform-copy.js'

const keys = [
  'Switch accounts',
  'Close account switcher',
  'Accounts you signed in to on this browser.',
  'Add account',
  'Sign out of all accounts',
  'Current account',
  'Sign in again',
  'Unavailable',
  'Administrator',
  'More actions',
  'Remove',
  'Remove from this browser',
  'Request failed',
  'Loading…',
] satisfies PlatformMessageKey[]
const copy = Object.fromEntries(
  Object.entries(platformMessages).map(([locale, messages]) => [locale, Object.fromEntries(keys.map(key => [key, messages[key]]))]),
)

export const nativeAccountSwitchCss = `
.phalanx-account-switch-list {
 display: grid;
 gap: 4px;
}
.phalanx-account-switch-row {
 display: grid;
 grid-template-columns: minmax(0, 1fr) auto;
 align-items: center;
 justify-items: end;
 gap: 4px;
}
.phalanx-account-switch-row .phalanx-account-switch-choice {
 display: flex;
 justify-content: flex-start;
 justify-self: stretch;
 gap: 8px;
 min-width: 0;
 height: auto;
 min-height: 44px;
 padding: 6px 8px;
 text-align: start;
 white-space: normal;
}
.phalanx-account-switch-identity {
 display: grid;
 gap: 2px;
 min-width: 0;
}
.phalanx-account-switch-meta {
 display: flex;
 flex-wrap: wrap;
 align-items: center;
 gap: 4px;
}
.phalanx-account-switch-actions {
 display: flex;
 flex-wrap: wrap;
 justify-content: flex-end;
 gap: 8px;
 min-width: 0;
}
.phalanx-account-switch-actions .phalanx-account-switch-action {
 padding-inline: 10px;
}
`

/** Native SDK controls provide the account dialog's interaction and theme. */
export const nativeAccountSwitchClient = `
const accountSwitchCopy=${JSON.stringify(copy)};
function submitAccountAction(path,marker){
 const form=document.createElement('form');form.method='post';form.action=path;form.hidden=true;
 if(marker!==undefined){const input=document.createElement('input');input.type='hidden';input.name='marker';input.value=marker;form.appendChild(input)}
 document.body.appendChild(form);form.requestSubmit();
}
function AccountSwitchRow({account,text,remove,busy}){
 const [more,setMore]=React.useState(false);
 const metaId=React.useId();
 const status=account.status==='current'?'Current account':account.status==='reauthentication-required'?'Sign in again':account.status==='unavailable'?'Unavailable':undefined;
 const hasMeta=account.admin||status!==undefined;
 const choose=()=>{if(account.status==='available')submitAccountAction('/account/switch',account.marker);else if(account.status==='reauthentication-required')location.assign('/login?username='+encodeURIComponent(account.username));else if(account.status==='current')location.assign(account.admin?'/admin':'/')};
 const removal=()=>{setMore(false);void remove(account.marker)};
 return h('div',{role:'listitem',className:'phalanx-account-switch-row'},
  h(Button,{type:'button',variant:'ghost',className:'phalanx-account-switch-choice',disabled:busy||account.status==='unavailable','aria-label':account.username,'aria-describedby':hasMeta?metaId:undefined,title:account.username,onClick:choose},
   h('span',{className:'phalanx-account-avatar','aria-hidden':true},account.username.slice(0,1).toUpperCase()),
   h('span',{className:'phalanx-account-switch-identity'},
    h('span',{className:'phalanx-account-name'},account.username),
    hasMeta?h('span',{className:'phalanx-account-switch-meta',id:metaId},
     account.admin?h(Tag,{tone:'neutral'},text('Administrator')):null,
     status?h(Tag,{tone:account.status==='current'?'solid':'quiet'},text(status)):null
    ):null
   )
  ),
  account.status==='unavailable'?h(Button,{type:'button',size:'sm',disabled:busy,title:text('Remove from this browser'),onClick:removal},text('Remove')):
   h(Menu,{open:more,portal:true,autoFocus:true,anchor:h(Button,{type:'button',size:'sm',disabled:busy,'aria-label':text('More actions'),title:text('Remove from this browser'),'aria-expanded':more,onClick:()=>setMore(value=>!value)},'⋯'),items:[{id:'remove',label:h('span',{title:text('Remove from this browser')},text('Remove'))}],onClose:()=>setMore(false),onSelect:removal})
 );
}
function AccountSwitchDialog({open,onClose,locale}){
 const text=key=>(accountSwitchCopy[locale]||accountSwitchCopy.en)[key]||key;
 const [accounts,setAccounts]=React.useState();const [error,setError]=React.useState(false);const [busy,setBusy]=React.useState(false);const pending=React.useRef(false);
 React.useEffect(()=>{if(!open)return;const controller=new AbortController();setAccounts(undefined);setError(false);
  fetch('/account/signed-in',{credentials:'same-origin',signal:controller.signal}).then(async response=>{if(!response.ok)throw Error();const value=await response.json();if(!controller.signal.aborted)setAccounts(value.accounts)}).catch(()=>{if(!controller.signal.aborted)setError(true)});
  return()=>controller.abort();
 },[open]);
 async function remove(marker){
  if(pending.current)return;pending.current=true;setBusy(true);setError(false);
  try{const response=await fetch('/account/signed-in/remove',{method:'POST',credentials:'same-origin',body:new URLSearchParams({marker})});if(!response.ok)throw Error();const listing=await fetch('/account/signed-in',{credentials:'same-origin'});if(!listing.ok)throw Error();setAccounts((await listing.json()).accounts)}catch{setError(true)}finally{pending.current=false;setBusy(false)}
 }
 return h(Modal,{open,onClose,title:text('Switch accounts'),closeLabel:text('Close account switcher'),description:text('Accounts you signed in to on this browser.'),footer:h('div',{className:'phalanx-account-switch-actions'},h(Button,{type:'button',className:'phalanx-account-switch-action',variant:'outline',onClick:()=>location.assign('/login?other=1')},text('Add account')),h(Button,{type:'button',className:'phalanx-account-switch-action',variant:'ghost',disabled:busy,onClick:()=>submitAccountAction('/account/signed-in/remove-all')},text('Sign out of all accounts')))},
  error?h('p',{role:'alert'},text('Request failed')):null,
  accounts?h('div',{role:'list',className:'phalanx-account-switch-list','aria-label':text('Switch accounts')},accounts.map(account=>h(AccountSwitchRow,{key:account.marker,account,text,remove,busy}))):!error?h('p',{role:'status'},text('Loading…')):null
 );
}
`
