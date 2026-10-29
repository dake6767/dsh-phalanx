/** Self-contained file previews run in an opaque iframe with restricted resource loading. */
export function htmlPreviewDocument(data: Uint8Array): string {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(data)
  const policy =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '">' + source
}

/** Higher-priority official renderer; coding-view preferences remain entirely native. */
export const htmlPreviewClient = `
  isolated(()=>ctx.inject(['documentPreviews'], preview=>{
    try {
      const ns='phalanx-html';
      preview.effect(()=>ctx.locale.register(ns,{en:{title:'Interactive HTML',failed:'HTML preview is unavailable. Reload to try again.'},zh:{title:'交互式 HTML',failed:'HTML 预览暂不可用，请刷新重试。'}}));
      const text=ctx.locale.bind(ns);
      function FailedHtml(){React.useSyncExternalStore(subscribe,snapshot);return h('p',{role:'alert'},text('failed'))}
      let Body=FailedHtml;
      isolated(()=>{
        const documentHtml=${htmlPreviewDocument.toString()};
        function HtmlBody({content,resourceAddress}){
          React.useSyncExternalStore(subscribe,snapshot);
          const source=React.useMemo(()=>content.kind==='bytes'?documentHtml(content.data):undefined,[content]);
          if(source===undefined)return null;
          return h('iframe',{key:resourceAddress,srcDoc:source,sandbox:'allow-scripts allow-forms',title:text('title'),style:{width:'100%',height:'100%',minHeight:'400px',border:0,background:'white'}});
        }
        Body=HtmlBody;
      });
      function SafeHtml(props){return h(ModuleBoundary,{fallback:h(FailedHtml)},h(Body,props))}
      preview.effect(()=>preview.documentPreviews.register({id:'phalanx-html',extensions:['html','htm'],priority:'extension',title:()=>text('title'),loading:'bytes-complete',wrap:false}));
      isolated(()=>preview.slots.inject('sidebar.right.tab.document',()=>isolated(()=>preview.slots.register({name:'sidebar.right.tab.document',key:'phalanx-html',locale:ns},SafeHtml))));
    }catch{console.warn('Platform HTML previews are unavailable')}
  }));
`
