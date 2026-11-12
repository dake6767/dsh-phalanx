import { BUILTIN_NATIVE_PRESET_IDS } from '../domain/native-features.js'
import { DSH_SETTINGS_UPDATE } from './settings-protocol.js'
import { DSH_RPC_PREFIX } from './session-protocol.js'

export const NATIVE_PRESET_DEFAULT = 'phalanxNativePresets/default'

/** Read the effective native selection without replacing any member registry configuration. */
export const nativePresetDefaultModule = `
export const name='phalanx-native-preset-default';
export const inject=['connection','agentPresets'];
export function apply(ctx) {
  ctx.connection.fetch.register({
    path:${JSON.stringify(DSH_RPC_PREFIX + NATIVE_PRESET_DEFAULT)},methods:['POST'],requestBody:'buffered',
    fetch:async request=>{
      let body;
      try {body=await request.json();} catch {return new Response('Invalid RPC request',{status:400});}
      if (body?.type!=='client-request' || typeof body.rpcId!=='string' || body.method!==${JSON.stringify(NATIVE_PRESET_DEFAULT)}
        || !body.payload?.args || typeof body.payload.args!=='object' || Array.isArray(body.payload.args) || Object.keys(body.payload.args).length)
        return new Response('Invalid RPC request',{status:400});
      return Response.json({type:'server-response',rpcId:body.rpcId,result:{ok:true,value:{defaultId:ctx.agentPresets.defaultId}}});
    },
  });
}
`

export function nativePresetSelection(disabledIds: readonly string[]): { readonly disabled: readonly string[]; readonly fallback: string } | undefined {
  const disabled = BUILTIN_NATIVE_PRESET_IDS.filter(id => disabledIds.includes(`preset-${id}`))
  if (!disabled.length) return undefined
  const fallback = BUILTIN_NATIVE_PRESET_IDS.find(id => !disabled.includes(id))
  if (!fallback) throw new TypeError('At least one built-in Agent preset must remain available')
  return { disabled, fallback }
}

export type NativePresetSettingsRpc = (method: string, args: object, signal: AbortSignal) => Promise<unknown>

/** Repair only an effective disabled builtin through the official revisioned settings seam. */
export async function repairNativePresetDefault(disabledIds: readonly string[], remote: NativePresetSettingsRpc, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const selection = nativePresetSelection(disabledIds)
  if (!selection) return
  let writes = 0
  for (;;) {
    signal.throwIfAborted()
    const current = await presetState(remote, signal)
    signal.throwIfAborted()
    if (!selection.disabled.includes(current.defaultId)) return
    if (writes++ >= 3) throw new Error('Native Agent preset default changed repeatedly during startup')
    try {
      await remote(
        DSH_SETTINGS_UPDATE,
        { ns: 'agent-preset-registry', patch: { selectedDefault: selection.fallback }, expectedRevision: current.revision },
        signal,
      )
    } catch (error) {
      signal.throwIfAborted()
      const latest = await presetState(remote, signal)
      signal.throwIfAborted()
      if (!selection.disabled.includes(latest.defaultId)) return
      if (latest.revision === current.revision) throw error
    }
  }
}

async function presetState(remote: NativePresetSettingsRpc, signal: AbortSignal): Promise<{ readonly revision: number; readonly defaultId: string }> {
  const settings = presetSettings(await remote('settings/describe', {}, signal))
  signal.throwIfAborted()
  const value = await remote(NATIVE_PRESET_DEFAULT, {}, signal)
  signal.throwIfAborted()
  if (typeof value !== 'object' || value === null || !('defaultId' in value) || typeof value.defaultId !== 'string')
    throw new TypeError('Native Agent preset default is unavailable')
  return { revision: settings.revision, defaultId: value.defaultId }
}

function presetSettings(snapshot: unknown): { readonly revision: number; readonly selectedDefault: string | undefined } {
  if (typeof snapshot !== 'object' || snapshot === null || !('namespaces' in snapshot) || !Array.isArray(snapshot.namespaces))
    throw new TypeError('Native settings namespaces are unavailable')
  const row = snapshot.namespaces.find((value: unknown) => typeof value === 'object' && value !== null && 'ns' in value && value.ns === 'agent-preset-registry')
  if (
    !row ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    typeof row.value !== 'object' ||
    row.value === null ||
    Array.isArray(row.value) ||
    (row.value.selectedDefault !== undefined && typeof row.value.selectedDefault !== 'string')
  )
    throw new TypeError('Native Agent preset settings are unavailable')
  return { revision: row.revision, selectedDefault: row.value.selectedDefault }
}
