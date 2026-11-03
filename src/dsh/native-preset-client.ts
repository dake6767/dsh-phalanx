const packageName = '@dsh-phalanx/native-preset-controls'
export const nativePresetClientEntry = 'preset-controls/index.mjs'

/** Member-local presentation using only the public module table, slots and menu primitives. */
export const nativePresetClient = `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:require=>{
  const React=require('react');
  const {MenuItemButton}=require('@deepseek-ai/dsh-client-ui-primitives');
  const h=React.createElement;
  return {name:'phalanx-native-presets-client',inject:['slots','locale','pluginNavigation'],apply(ctx){
    const namespace='phalanx-native-presets';
    ctx.effect(()=>ctx.locale.register(namespace,{en:{browse:'Browse other plugins'},zh:{browse:'浏览其他插件'}}));
    const register=(name,conversation)=>ctx.slots.inject(name,()=>ctx.slots.register(
      {name,id:'entry-customization',locale:namespace,priority:-1},
      ({entries=[],onOpen,onDismiss,t})=>{
        const views=conversation?entries:[];
        return h(React.Fragment,null,
          views.map(view=>h(MenuItemButton,{key:view.id,current:view.active===true,onSelect:()=>{onDismiss();onOpen(view.id)}},view.label)),
          h(MenuItemButton,{separatorBefore:views.length>0,onSelect:()=>{onDismiss();ctx.pluginNavigation.openList()}},t('browse')));
      },
    ));
    register('sidebar.panellist.actions',false);
    register('conversation.session.header.views.actions',true);
    register('sidebar.right.tab.guide.actions',false);
    ctx.slots.inject('plugins.add.actions',()=>ctx.slots.register({name:'plugins.add.actions',id:'create-plugin',priority:-1},()=>null));
  }};
}});`

export function nativePresetClientFiles(): Readonly<Record<string, string>> {
  return {
    'preset-controls/package.json': JSON.stringify({
      name: packageName,
      version: '1.0.0',
      type: 'module',
      main: './index.mjs',
      exports: { '.': './index.mjs', './client': './client.js' },
      dsh: {
        client: {
          platform: 'web',
          inject: [
            '@deepseek-ai/dsh-client-ui-renderer',
            '@deepseek-ai/dsh-client-locale',
            '@deepseek-ai/dsh-client-ui-sidebar',
            '@deepseek-ai/dsh-client-ui-conversation',
            '@deepseek-ai/dsh-client-ui-sidebar-right',
            '@deepseek-ai/dsh-client-ui-plugin-manager',
          ],
        },
      },
    }),
    [nativePresetClientEntry]: "export const name='phalanx-native-presets'; export function apply() {}\n",
    'preset-controls/client.js': nativePresetClient,
  }
}
