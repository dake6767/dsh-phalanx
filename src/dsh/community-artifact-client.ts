/** Contributions use the viewed Session props supplied by the official slot owner. */
export const artifactDownloadClient = `
  isolated(()=>{
    const artifactNamespace='phalanx-artifacts';
    ctx.effect(()=>ctx.locale.register(artifactNamespace,{en:{download:'Download',downloading:'Preparing download…',failed:'Download failed. The file may have changed or become unavailable. Refresh and try again.'},zh:{download:'下载',downloading:'正在准备下载…',failed:'下载失败，文件可能已变更或无法访问。请刷新后重试。'}}));
    const text=ctx.locale.bind(artifactNamespace);
    function DownloadFailure(){React.useSyncExternalStore(subscribe,snapshot);return h('span',{role:'alert'},text('failed'))}
    let Action=DownloadFailure;
    isolated(()=>{
    function DownloadAction(props){
      React.useSyncExternalStore(subscribe,snapshot);
      const [busy,setBusy]=React.useState(false);const [failed,setFailed]=React.useState(false);const frame=React.useRef(null);const abort=React.useRef(null);
      React.useEffect(()=>()=>{abort.current?.abort();frame.current?.remove()},[]);
      async function download(){
        setBusy(true);setFailed(false);abort.current?.abort();const controller=new AbortController();abort.current=controller;
        try{
          const url=new URL('api/phalanx.download',document.baseURI);
          if(props.actionUrl){
            const action=new URL(props.actionUrl,document.baseURI);
            if(!action.pathname.endsWith('/api/present.open')||action.searchParams.get('sessionId')!==props.sessionId)throw Error('Invalid file reference');
            for(const key of ['sessionId','seq','index']){const value=action.searchParams.get(key);if(value===null)throw Error('Invalid file reference');url.searchParams.set(key,value)}
          }else{url.searchParams.set('sessionId',props.sessionId);url.searchParams.set('path',props.absolutePath)}
          const response=await fetch(url,{method:'POST',credentials:'same-origin',signal:controller.signal});
          if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('File unavailable');
          const prepared=await response.json();if(typeof prepared.version!=='string')throw Error('File unavailable');
          url.searchParams.set('version',prepared.version);
          frame.current?.remove();const target=document.createElement('iframe');target.hidden=true;target.title=text('download');frame.current=target;
          // An attachment does not navigate this frame. An error or login response does.
          target.onload=()=>{if(target.getAttribute('src')!==null)setFailed(true)};
          target.src=url.href;document.body.appendChild(target);
        }catch{if(!controller.signal.aborted)setFailed(true)}finally{if(!controller.signal.aborted)setBusy(false)}
      }
      return h('span',{style:{display:'inline-flex',alignItems:'center',gap:'6px',flexWrap:'wrap'}},h(Button,{size:'sm',disabled:busy,onClick:download},text(busy?'downloading':'download')),failed?h(DownloadFailure):null);
    }
    Action=DownloadAction;
    });
    function SafeDownload(props){return h(ModuleBoundary,{fallback:h(DownloadFailure)},h(Action,props))}
    for(const name of ['deliverables.file.actions','sidebar.right.tab.document.actions','sidebar.right.tab.document.unpreviewable'])slot(name,()=>ctx.slots.register({name,id:'phalanx-download',locale:artifactNamespace},SafeDownload));
  });
`
