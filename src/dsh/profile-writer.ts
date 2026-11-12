/** Resolve the official profile writer from the running DSH CLI. */
export const dshProfileWriterLoader = `
async function loadDshProfileWriter(require, pathToFileURL) {
  return await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href);
}
`
