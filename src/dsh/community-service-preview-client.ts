/** Navigation belongs to the trusted platform; no previewed scripts enter native DSH. */
export const servicePreviewClient = `
  isolated(()=>{
    const ns='phalanx-service-preview';
    ctx.effect(()=>ctx.locale.register(ns,{en:{open:'Service preview',failed:'Service preview is unavailable. Reload to try again.'},zh:{open:'服务预览',failed:'服务预览暂不可用，请刷新重试。'}}));
    const text=ctx.locale.bind(ns);
    function PreviewFailure(){React.useSyncExternalStore(subscribe,snapshot);return h('span',{role:'alert'},text('failed'))}
    let Link=PreviewFailure;
    isolated(()=>{
      const openPreview=()=>window.open('/service-preview/','_blank','noopener');
      function PreviewLink(){React.useSyncExternalStore(subscribe,snapshot);return h(Button,{variant:'ghost',size:'sm',onClick:openPreview},text('open'))}
      Link=PreviewLink;
    });
    slot('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'phalanx-service-preview',locale:ns},()=>h(ModuleBoundary,{fallback:h(PreviewFailure)},h(Link))));
  });
`
