import { join } from 'node:path'
import { DSH_CONTAINER_HOME, dshHomePath } from './profile-layout.js'
import type { PreparedVoice } from '../ports/platform-voice.js'

export const nativeVoiceBundle = '@deepseek-ai/dsh-experimental-voice-input-bundle'
export const voiceMount = '/dsh-phalanx/voice'
const entries = ['speech-to-text', 'speech-to-text-sensevoice', 'api-speech-to-text', 'ui-voice-input']

/** Disabled rows prevent optional native activation from triggering per-member model downloads. */
export function nativeVoiceLaunch(voice: PreparedVoice | undefined, container: boolean, home: string) {
  if (!voice) return { rows: entries.map(id => ({ id, disabled: true })), volumes: [] }
  const dataRoot = join(dshHomePath(container ? DSH_CONTAINER_HOME : home), 'speech-to-text', 'sensevoice')
  const modelDirectory = container ? voiceMount + '/model' : voice.modelDirectory
  const vadModelPath = container ? voiceMount + '/silero_vad.onnx' : voice.vadModelPath
  return {
    rows: [{ id: 'speech-to-text-sensevoice', config: { dataRoot, precision: voice.precision, modelDirectory, vadModelPath } }],
    volumes: container
      ? [
          { host: voice.modelDirectory, mounted: modelDirectory },
          { host: voice.vadModelPath, mounted: vadModelPath },
        ]
      : [],
  }
}
