import { featureVisible } from '../domain/release-visibility.js'

/** The panel observes accepted background work; closing it never cancels installation. */
export const nativePluginsTab = `
function PluginsPanel({ setupOnly = false } = {}) {
 const locale = React.useSyncExternalStore(subscribe, snapshot) === 'zh' ? 'zh-CN' : 'en';
 const text = marketText(locale);
 const [plugins, setPlugins] = React.useState();
 const [unlisted, setUnlisted] = React.useState([]);
 const [nativeServices, setNativeServices] = React.useState([]);
 const [preinstallFailures, setPreinstallFailures] = React.useState([]);
 const [error, setError] = React.useState();
 const [notice, setNotice] = React.useState();
 const [busy, setBusy] = React.useState();
 const [revision, setRevision] = React.useState(0);
 const [dismissed, setDismissed] = React.useState(() => new Set());
 const pending = React.useRef(false);
 const mounted = React.useRef(false);
 const observing = React.useRef();
 const request = options => marketRequest(setupOnly ? '/market/api/plugins/setup' : '/market/api/plugins', options);

 React.useEffect(() => {
  mounted.current = true;
  return () => {
   mounted.current = false;
   observing.current?.abort();
  };
 }, []);
 React.useEffect(() => {
  const controller = new AbortController();
  let timer;
  async function load() {
   let active = false;
   try {
    const data = await request({ signal: controller.signal });
    if (controller.signal.aborted) return;
    const updates = data.unlistedUpdates ?? [];
    const rows = data.plugins ?? [];
    setPlugins(rows);
    setUnlisted(updates);
    setNativeServices(data.nativeServices ?? []);
    setPreinstallFailures(data.preinstallFailures ?? []);
    setNotice(data.pending ? 'restart-required' : undefined);
    setError(undefined);
    active = [...rows, ...updates].some(row => row.job?.status === 'running');
   } catch (failure) {
    if (controller.signal.aborted) return;
    setPlugins(undefined);
    setUnlisted([]);
    setNativeServices([]);
    setPreinstallFailures([]);
    setNotice(undefined);
    setError(failure);
   } finally {
    if (!controller.signal.aborted) timer = setTimeout(load, active ? 750 : 5000);
   }
  }
  void load();
  return () => {
   controller.abort();
   clearTimeout(timer);
  };
 }, [revision]);

 async function change(packageName, action, target) {
  if (pending.current) return;
  pending.current = true;
  const controller = new AbortController();
  observing.current = controller;
  setBusy(packageName);
  setError(undefined);
  setNotice(undefined);
  const requestId = Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).join('-');
  try {
   const setup = action === 'retry-settings' || action === 'retry-preinstall';
   const send = setup ? options => marketRequest('/market/api/plugins/setup', options) : request;
   const result = await send({
    method: 'POST',
    signal: controller.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(setup ? { packageName, action } : { packageName, action, requestId, ...(target ? { target } : {}) }),
   });
   if (!mounted.current) return;
   if (result.job) setPlugins(rows => rows?.map(row => row.packageName === packageName ? { ...row, job: result.job } : row));
   if (!setup) setNotice(result.application);
   setRevision(value => value + 1);
  } catch (failure) {
   if (mounted.current) setError(failure);
  } finally {
   pending.current = false;
   observing.current = undefined;
   if (mounted.current) setBusy(undefined);
  }
 }

 function restartPrompt(job, message) {
  return h('div', { role: 'status', className: 'phalanx-market-notice' },
   h('p', { className: 'phalanx-market-status' }, text(message)),
   dismissed.has(job.requestId) ? null : h('div', { className: 'phalanx-market-actions' },
    h(Button, { variant: 'outline', size: 'sm', onClick: () => location.assign('/recovery?restart=1') }, text('Restart instance')),
    h(Button, { variant: 'outline', size: 'sm', onClick: () => setDismissed(previous => new Set([...previous, job.requestId])) }, text('Later'))));
 }

 function operation(job) {
  if (!job) return null;
  if (job.status === 'succeeded' && job.action === 'update') {
   return restartPrompt(job, job.application === 'restart-required' ? 'Update complete. Restart required.' : 'Update complete. Restarting DSH is recommended.');
  }
  if (job.status === 'failed') {
   return h(React.Fragment, null,
    h(MarketFailure, { error: job.failure, locale }),
    job.application === 'restart-required' ? restartPrompt(job, 'Recovery saved. Restart required.') : null,
    job.failure?.params?.recovery ? h('p', { className: 'phalanx-market-status' }, text('Recovery files: {recovery}', { recovery: job.failure.params.recovery })) : null);
  }
  if (job.status !== 'running') return null;
  let phase = 'Preparing installation…';
  if (job.phase === 'downloading') phase = 'Downloading plugin…';
  if (job.phase === 'installing') phase = job.action === 'update' ? 'Updating plugin…' : 'Installing plugin…';
  if (job.phase === 'removing') phase = 'Removing plugin…';
  return h('div', { role: 'status' },
   h('p', { className: 'phalanx-market-status' }, text(phase)),
   h('progress', { 'aria-label': text(phase) }));
 }

 function actions(plugin, running) {
  const removing = plugin.job?.action === 'uninstall';
  const updating = plugin.job?.action === 'update';
  const failed = plugin.job?.status === 'failed';
  const removable = plugin.status === 'selected' || plugin.status === 'installed';
  const readOnly = plugin.status === 'managed' || plugin.status === 'native';
  if (plugin.status === 'unknown' && !running) return null;
  let label = removable ? 'Uninstall' : 'Install';
  if (running) label = updating ? 'Updating plugin…' : removing ? 'Removing…' : 'Installing…';
  else if (busy === plugin.packageName) label = 'Saving…';
  else if (readOnly) label = 'Installed';
  else if (failed && removable && removing) label = 'Retry uninstall';
  else if (failed && !removable && !removing && !updating) label = 'Retry installation';
  return h('div', { className: 'phalanx-market-actions phalanx-market-action' },
   plugin.retryReceipt && !running ? h(Button, {
    variant: 'outline', size: 'sm', disabled: busy !== undefined,
    onClick: () => void change(plugin.packageName, 'retry-receipt'),
   }, text('Retry saving installation record')) : null,
   plugin.update && !running ? h(Button, {
    variant: 'outline', size: 'sm', disabled: busy !== undefined,
    onClick: () => void change(plugin.packageName, 'update', plugin.update.target),
   }, text('Update plugin')) : null,
   h(Button, {
    variant: 'outline', size: 'sm', disabled: busy !== undefined || running || readOnly,
    onClick: () => void change(plugin.packageName, removable ? 'uninstall' : 'install'),
   }, text(label)));
 }

 function serviceStatus(packageName) {
  const bindings = nativeServices.find(row => row.packageName === packageName)?.bindings ?? [];
  const statusText = {
   pending: 'Platform settings changed. Apply them to this plugin.',
   failed: 'Platform service setup failed.',
   inactive: 'Platform service unavailable. Choose a service in the plugin settings.',
   conflict: 'Plugin settings changed. Review them before retrying.',
   unsupported: 'This plugin version or configuration does not support platform services.',
  };
  const retry = bindings.some(binding => ['failed', 'conflict', 'inactive', 'pending'].includes(binding.status));
  const refresh = bindings.some(binding => binding.refresh);
  const pending = bindings.some(binding => binding.status === 'pending');
  return h(React.Fragment, null,
   bindings.filter(binding => statusText[binding.status]).map(binding => h('p', {
    key: binding.slot, className: 'phalanx-market-status', role: 'status',
   }, (binding.slot ? binding.slot + ' · ' : '') + text(statusText[binding.status]))),
   retry ? h(Button, {
    variant: 'outline', size: 'sm', disabled: busy !== undefined,
    onClick: () => void change(packageName, 'retry-settings'),
   }, text(pending ? 'Apply service settings' : 'Retry service setup')) : null,
   refresh ? h('p', { className: 'phalanx-market-status', role: 'status' }, text('Platform settings saved. Reload the plugin panel.')) : null);
 }

 function row(plugin) {
  const running = plugin.job?.status === 'running';
  const state = {
   native: 'Installed on the native plugin page',
   install: 'Not installed',
   unknown: 'Installation status unavailable',
  }[plugin.status] ?? 'Installed';
  const updateLabel = plugin.update?.kind === 'content' ? 'Content update available' : 'Update available';
  return h('li', { key: plugin.packageName, className: 'phalanx-market-row' },
   h('span', { className: 'phalanx-market-icon', 'aria-hidden': true }, h(IconPluginPinwheelOutlineRegular, { size: 24 })),
   h('div', { className: 'phalanx-market-main' },
    h('div', { className: 'phalanx-market-title' },
     h('h3', null, plugin.title),
     h(Tag, { tone: 'quiet' }, text(plugin.installedVersion ? 'Installed version' : 'Version') + ' ' + (plugin.installedVersion ?? plugin.version)),
     plugin.status === 'managed' ? h(Tag, { tone: 'quiet' }, text('Platform controlled, cannot uninstall')) : null,
     plugin.sharedCredential ? h(Tag, { tone: 'quiet' }, text('Platform shared KEY')) : null),
    h('p', { className: 'phalanx-market-description' }, plugin.description || plugin.packageName),
    ${featureVisible('contributions')} && plugin.contribution ? h('p', { className: 'phalanx-market-description' },
     text(plugin.contribution.anonymous ? 'Contributed anonymously' : 'Contributed by {name}', { name: plugin.contribution.name })) : null,
    h('p', { className: 'phalanx-market-status' }, text(state)),
    plugin.update && !running ? h('p', { className: 'phalanx-market-status' }, text(updateLabel) + ' · ' + plugin.update.version) : null,
    operation(plugin.job), serviceStatus(plugin.packageName)),
   actions(plugin, running));
 }

 const showNotice = notice && !(notice === 'restart-required' && plugins?.some(({ job }) =>
  job?.action === 'update' && job.status === 'succeeded' && job.application === 'restart-required'));
 return h('div', { className: 'phalanx-market-tab-content' },
  h('header', { className: 'phalanx-market-head' },
   h('div', null, h('h2', null, text(setupOnly ? 'Plugin setup' : 'Plugins')),
    setupOnly ? null : h('p', { className: 'phalanx-market-intro' }, text('Install plugins into your DSH. Shared-key and controlled plugins load read-only.'))),
   h(Button, {
    variant: 'ghost', size: 'sm', className: 'phalanx-market-refresh',
    title: text('Reload plugins'), 'aria-label': text('Reload plugins'),
    onClick: () => setRevision(value => value + 1), icon: h(IconRefreshOutlineRegular, { size: 16 }),
   })),
  h(MarketFailure, { error, locale }),
  unlisted.map(({ packageName, job }) => h('div', { key: packageName, className: 'phalanx-market-notice' }, h('h3', null, packageName), operation(job))),
  nativeServices.filter(({ packageName }) => !plugins?.some(row => row.packageName === packageName)).map(({ packageName }) =>
   h('div', { key: 'services-' + packageName, className: 'phalanx-market-notice' }, h('h3', null, packageName), serviceStatus(packageName))),
  preinstallFailures.map(({ packageName, restartRequired }) =>
   h('div', { key: 'preinstall-' + packageName, className: 'phalanx-market-notice' },
    h('h3', null, packageName),
    h('p', { role: 'status' }, text(restartRequired ? 'Preinstalled plugin needs the next startup to finish setup.' : 'Preinstalled plugin is not ready.')),
    restartRequired ? h('a', { href: '/recovery?restart=1' }, text('Restart DSH instance')) :
     h(Button, { variant: 'outline', size: 'sm', disabled: busy !== undefined,
      onClick: () => void change(packageName, 'retry-preinstall'),
     }, text('Retry installation')))),
  showNotice ? h('div', { role: 'status', className: 'phalanx-market-notice' },
   h('p', { className: 'phalanx-market-status' }, text(notice === 'applied' ? 'Selection saved.' : 'Changes take effect after restarting your instance.')),
   notice === 'restart-required' ? h('a', { href: '/recovery?restart=1' }, text('Restart DSH instance')) : null) : null,
  plugins === undefined ? (error ? null : h('p', { role: 'status', className: 'phalanx-market-status' }, text('Loading…'))) : setupOnly ? null :
   h('section', { className: 'phalanx-market-group', 'aria-label': text('All plugins') },
    h('div', { className: 'phalanx-market-group-head' }, h('h2', null, text('All plugins')), h('span', { className: 'phalanx-market-count' }, plugins.length)),
    plugins.length === 0 ? h('p', { className: 'phalanx-market-status' }, text('No published plugins')) : h('ul', { className: 'phalanx-market-list' }, plugins.map(row))));
}
`
