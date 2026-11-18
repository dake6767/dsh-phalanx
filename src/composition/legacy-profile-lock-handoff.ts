import { stopPredecessor } from '../adapters/legacy-profile-lock-handoff.js'

const [dataRoot, configFile, userDataRoot, userDataMount] = process.argv.slice(2)
if (!dataRoot || !configFile) {
  console.error('The installed data root and database configuration are required')
  process.exitCode = 1
} else {
  try {
    await stopPredecessor(dataRoot, configFile, userDataRoot || undefined, userDataMount || undefined)
  } catch {
    console.error('Could not complete legacy member profile lock handoff')
    process.exitCode = 1
  }
}
