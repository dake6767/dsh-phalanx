/** Browser event handoff contains no identity or session data. */
export const ACCOUNT_EVENT_COOKIE = 'dsh-phalanx_account_event'
export const PLATFORM_ACCOUNT_SYNC_SCRIPT = `(()=>{
 if(typeof BroadcastChannel!=='function'||window.dshPhalanxAccountSync)return;
 const channel=new BroadcastChannel('dsh-phalanx.account-change');window.dshPhalanxAccountSync=channel;
 const types=['switched','logged-out','signed-out-all'];
 channel.onmessage=event=>{const value=event.data;if(value&&Object.keys(value).length===1&&types.includes(value.type))location.pathname==='/account/changed'?location.reload():location.replace('/account/changed')};
 const event=document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('${ACCOUNT_EVENT_COOKIE}='))?.slice('${ACCOUNT_EVENT_COOKIE}='.length);
 if(types.includes(event)&&location.pathname!=='/account/changed'){document.cookie='${ACCOUNT_EVENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict'+(location.protocol==='https:'?'; Secure':'');channel.postMessage({type:event})}
 addEventListener('pageshow',event=>{if(event.persisted)location.reload()});
 addEventListener('pagehide',()=>{channel.close();delete window.dshPhalanxAccountSync},{once:true});
})()`
