import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const layers = new Set(['domain', 'ports', 'adapters', 'dsh', 'use-cases', 'inbound', 'composition'])

export function countCssCodeLines(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, match => match.replace(/[^\n]/gu, ' '))
  return withoutComments.split('\n').filter(line => line.trim() !== '').length
}

export function countJsCodeLines(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
  const commentRanges = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      commentRanges.push([scanner.getTokenPos(), scanner.getTextPos()])
    }
  }
  let withoutComments = source
  for (const [start, end] of commentRanges.reverse()) {
    const comment = withoutComments.slice(start, end)
    withoutComments = withoutComments.slice(0, start) + comment.replace(/[^\n]/gu, ' ') + withoutComments.slice(end)
  }
  return withoutComments.split('\n').filter(line => line.trim() !== '').length
}

async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await files(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

export async function auditArchitectureAssets(base = root) {
  const errors = []
  for (const file of await files(join(base, 'src'))) {
    const path = relative(base, file).split(sep).join('/')
    if (!layers.has(path.split('/')[1])) errors.push(`${path}: source file has no architecture layer`)
    if (!/\.(?:ts|tsx)$/u.test(path)) errors.push(`${path}: unexpected source extension`)
  }
  for (const file of await files(join(base, 'admin-ui/src'))) {
    if (!file.endsWith('.css')) continue
    const count = countCssCodeLines(await readFile(file, 'utf8'))
    if (count > 600) errors.push(`${relative(base, file)}: ${count} CSS code lines exceed 600`)
  }
  for (const file of await files(join(base, 'tests'))) {
    if (!/\.(?:mjs|js)$/u.test(file)) continue
    const count = countJsCodeLines(await readFile(file, 'utf8'))
    if (count > 800) errors.push(`${relative(base, file)}: ${count} fixture code lines exceed 800`)
  }
  return errors
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await auditArchitectureAssets()
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error}\n`)
    process.exitCode = 1
  }
}
