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

/** Native SDK controls own the account dialog's layout, interaction and theme. */
export const nativeAccountSwitchClient = `
const accountSwitchCopy=${JSON.stringify(copy)};
function submitAccountAction(path,marker){
 const form=document.createElement('form');form.method='post';form.action=path;form.hidden=true;
 if(marker!==undefined){const input=document.createElement('input');input.type='hidden';input.name='marker';input.value=marker;form.appendChild(input)}
 document.body.appendChild(form);form.requestSubmit();
}
function AccountSwitchRow({account,text,remove,busy}){
 const [more,setMore]=React.useState(false);
 const status=account.status==='current'?'Current account':account.status==='reauthentication-required'?'Sign in again':account.status==='unavailable'?'Unavailable':undefined;
 const choose=()=>{if(account.status==='available')submitAccountAction('/account/switch',account.marker);else if(account.status==='reauthentication-required')location.assign('/login?username='+encodeURIComponent(account.username));else if(account.status==='current')location.assign(account.admin?'/admin':'/')};
 const removal=()=>{setMore(false);void remove(account.marker)};
 return h('div',{role:'listitem'},
  h(Button,{type:'button',variant:'ghost',disabled:busy||account.status==='unavailable','aria-label':account.username,onClick:choose,icon:h('span',{className:'phalanx-account-avatar','aria-hidden':true},account.username.slice(0,1).toUpperCase())},account.username),
  account.admin?h(Tag,{tone:'neutral'},text('Administrator')):null,
  status?h(Tag,{tone:account.status==='current'?'solid':'quiet'},text(status)):null,
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
 return h(Modal,{open,onClose,title:text('Switch accounts'),closeLabel:text('Close account switcher'),description:text('Accounts you signed in to on this browser.'),footer:h(React.Fragment,null,h(Button,{type:'button',variant:'outline',onClick:()=>location.assign('/login?other=1')},text('Add account')),h(Button,{type:'button',variant:'ghost',disabled:busy,onClick:()=>submitAccountAction('/account/signed-in/remove-all')},text('Sign out of all accounts')))},
  error?h('p',{role:'alert'},text('Request failed')):null,
  accounts?h('div',{role:'list','aria-label':text('Switch accounts')},accounts.map(account=>h(AccountSwitchRow,{key:account.marker,account,text,remove,busy}))):!error?h('p',{role:'status'},text('Loading…')):null
 );
}
`
