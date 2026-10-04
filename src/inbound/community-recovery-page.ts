/** Static platform page remains available when the user's DSH cannot load. */
export const COMMUNITY_RECOVERY_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Instance recovery · dsh-phalanx</title>
<style>body{font:16px system-ui;margin:5rem auto;padding:0 1.5rem;max-width:38rem;color:#18302c;background:#f4f7f5}button,a{font:inherit}button{padding:.7rem 1rem;margin:.7rem 0}label{display:block;margin:1rem 0}#status{min-height:2rem}nav{display:flex;gap:1rem;align-items:center}</style>
<main><h1>Instance recovery</h1><p>Restart your instance while keeping your configuration, plugins, conversations and files.</p>
<p>Running tasks and terminal commands will be interrupted. Other members keep working.</p>
<form id="restart"><label><input type="checkbox" required> I understand that my running tasks will be interrupted</label>
<button type="submit">Restart instance</button></form><p id="status" role="status" aria-live="polite"></p>
<nav><a id="return" href="/enter">Return to DSH</a><form action="/logout" method="post"><button>Log out</button></form></nav></main>
<script>
document.getElementById('restart').addEventListener('submit',async event=>{
 event.preventDefault();const button=event.currentTarget.querySelector('button');const status=document.getElementById('status');
 button.disabled=true;status.textContent='Restarting your instance…';
 try{const response=await fetch('/recovery/restart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true})});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'Restart failed');
 status.textContent='Instance restarted. Your saved data is ready.';document.getElementById('return').href=result.entry;
 }catch(error){status.textContent='Restart failed. '+error.message+' You can retry or ask an administrator to reset your DSH environment.'}
 finally{button.disabled=false}
});
</script></html>`
