import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const layers = new Set(['domain', 'ports', 'adapters', 'dsh', 'use-cases', 'inbound', 'composition'])
const allowed = {
  domain: new Set(['domain']),
  ports: new Set(['domain', 'ports']),
  'use-cases': new Set(['domain', 'ports', 'use-cases']),
  dsh: new Set(['domain', 'ports', 'dsh']),
  adapters: new Set(['domain', 'ports', 'dsh', 'adapters']),
  inbound: new Set(['domain', 'ports', 'dsh', 'use-cases', 'inbound']),
  composition: layers,
}
const ioModules = /^(?:node:)?(?:fs(?:\/promises)?|sqlite|child_process)$/u
const nonPureModules = /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns|fs(?:\/promises)?|sqlite|child_process|worker_threads|cluster|module|vm)$|^(?:ws|http-proxy-3|undici)$/u
const seamString = value => /^\/api\/|^(?:session|workspace|workspaceFiles|job|pluginManager|llm)\/[A-Za-z]|^DSH_(?!PHALANX_)[A-Z_]+$|\.cordis\.yml$/u.test(value)

const pathOf = filename => relative(root, filename).split(sep).join('/')
const layerOf = path => path.startsWith('src/') ? path.split('/')[1] : undefined
const digest = (rule, text) => createHash('sha256').update(`${rule}\n${text.trim()}`).digest('hex').slice(0, 20)

function ruleFactory(name, law, visitors) {
  return {
    meta: { type: 'problem', schema: [], docs: { description: `dsh-phalanx architecture law ${law}` } },
    create(context) {
      const file = pathOf(context.filename)
      const source = context.sourceCode
      const emit = (node, detail) => {
        const signature = digest(name, node.type === 'Program' ? file : source.getText(node))
        context.report({ node, message: `law ${law}: ${detail} [${signature}]` })
      }
      return visitors({ context, file, source, emit })
    },
  }
}

function importVisitors({ file, emit }) {
  const fromLayer = layerOf(file)
  const check = node => {
    const value = node.source?.value
    if (typeof value !== 'string') return
    if (value.startsWith('.')) {
      const target = pathOf(resolve(root, dirname(file), value)).replace(/\.js$/u, '.ts')
      const toLayer = layerOf(target)
      if (fromLayer !== undefined && toLayer === undefined) {
        emit(node, `${fromLayer} cannot import outside src/: ${value}`)
      } else if (fromLayer !== undefined && toLayer !== undefined && !allowed[fromLayer]?.has(toLayer)) {
        emit(node, `${fromLayer} cannot import ${toLayer}: ${value}`)
      }
    } else if (fromLayer !== undefined && ['domain', 'ports', 'use-cases'].includes(fromLayer) && nonPureModules.test(value)) {
      emit(node, `${fromLayer} cannot import infrastructure: ${value}`)
    }
  }
  const isolated = ['domain', 'ports', 'use-cases'].includes(fromLayer)
  return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check,
    ImportExpression(node) { if (isolated) emit(node, `${fromLayer} cannot dynamically import infrastructure`) },
    CallExpression(node) {
      if (!isolated) return
      if (node.callee.type === 'Identifier' && ['require', 'fetch', 'getBuiltinModule'].includes(node.callee.name)) {
        emit(node, `${fromLayer} cannot call ${node.callee.name}`)
      }
      if (node.callee.type === 'MemberExpression') {
        const property = node.callee.computed && node.callee.property.type === 'Literal'
          ? node.callee.property.value : node.callee.property.type === 'Identifier' ? node.callee.property.name : undefined
        if (['fetch', 'getBuiltinModule'].includes(property)) emit(node, `${fromLayer} cannot call ${property}`)
      }
    },
    NewExpression(node) {
      if (isolated && node.callee.type === 'Identifier' && ['WebSocket', 'EventSource', 'XMLHttpRequest'].includes(node.callee.name)) {
        emit(node, `${fromLayer} cannot construct ${node.callee.name}`)
      }
      if (isolated && node.callee.type === 'MemberExpression') {
        const property = node.callee.computed && node.callee.property.type === 'Literal'
          ? node.callee.property.value : node.callee.property.type === 'Identifier' ? node.callee.property.name : undefined
        if (['WebSocket', 'EventSource', 'XMLHttpRequest'].includes(property)) emit(node, `${fromLayer} cannot construct ${property}`)
      }
    },
    Program(node) {
      if (file.startsWith('src/') && !layers.has(fromLayer)) emit(node, `source file has no architecture layer: ${file}`)
    } }
}

function messageVisitors({ file, emit, source }) {
  if (!file.startsWith('src/') && !file.startsWith('admin-ui/src/')) return {}
  const aliases = new Set()
  const check = node => {
    const expression = node.test ?? node.discriminant
    if (expression === undefined) return
    const text = source.getText(expression)
    const direct = /\b(?:error|err|cause)\??\.(?:message|failure)\b|\[['"](?:message|failure)['"]\]|\.failure\b|\b(?:message|failure|reason)\??\.(?:includes|startsWith|endsWith|match)\s*\(|\.test\s*\(\s*(?:error\.message|message|failure)\s*\)/u.test(text)
    const aliased = [...aliases].some(name => new RegExp(`\\b${name}\\b`, 'u').test(text))
    if (direct || aliased) {
      emit(expression, 'business branch examines error or failure text')
    }
  }
  return { VariableDeclarator(node) {
    if (node.id.type === 'Identifier' && node.init !== null
      && /\.(?:message|failure)\b|\[['"](?:message|failure)['"]\]/u.test(source.getText(node.init))) aliases.add(node.id.name)
  }, IfStatement: check, ConditionalExpression: check, SwitchStatement: check, WhileStatement: check, DoWhileStatement: check, ForStatement: check }
}

function seamVisitors({ file, emit }) {
  if (!file.startsWith('src/') || layerOf(file) === 'dsh') return {}
  const check = node => {
    if (typeof node.value !== 'string') return
    if (seamString(node.value)) emit(node, `DSH protocol literal belongs in dsh/: ${node.value}`)
  }
  return { Literal: check, TemplateLiteral(node) {
    const value = node.quasis.map(part => part.value.cooked ?? part.value.raw).join('${}')
    if (seamString(value)) emit(node, `DSH protocol literal belongs in dsh/: ${value}`)
  } }
}

function ioVisitors({ file, emit }) {
  const layer = layerOf(file)
  if (layer === undefined || layer === 'adapters') return {}
  const check = node => {
    const value = node.source?.value
    if (typeof value === 'string' && ioModules.test(value)) emit(node, `I/O module belongs in adapters/: ${value}`)
  }
  return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check,
    ImportExpression(node) { emit(node, 'dynamic import can bypass the adapter I/O exit') },
    CallExpression(node) {
      const property = node.callee.type === 'MemberExpression'
        ? node.callee.computed && node.callee.property.type === 'Literal'
          ? node.callee.property.value : node.callee.property.type === 'Identifier' ? node.callee.property.name : undefined
        : undefined
      if (node.callee.type === 'Identifier' && ['require', 'getBuiltinModule'].includes(node.callee.name)
        || property === 'getBuiltinModule') {
        emit(node, 'dynamic module lookup can bypass the adapter I/O exit')
      }
    },
  }
}

function contractVisitors({ file, emit }) {
  if (!file.startsWith('admin-ui/src/')) return {}
  return {
    TSInterfaceDeclaration(node) {
      if (file === 'admin-ui/src/community-api.ts' || node.parent?.type === 'ExportNamedDeclaration') {
        emit(node, `frontend declares management API shape: ${node.id?.name ?? 'anonymous'}`)
      }
    },
    TSTypeAliasDeclaration(node) {
      if (node.typeAnnotation?.type === 'TSTypeLiteral'
        && (file === 'admin-ui/src/community-api.ts' || node.parent?.type === 'ExportNamedDeclaration')) {
        emit(node, `frontend declares management API shape: ${node.id?.name ?? 'anonymous'}`)
      }
    },
  }
}

function useCaseTestVisitors({ file, emit }) {
  if (!/^src\/use-cases\/[^/]+\.ts$/u.test(file)) return {}
  const name = file.slice('src/use-cases/'.length, -3)
  const testFile = `tests/${name}.spec.ts`
  return { Program(node) {
    if (!existsSync(resolve(root, testFile))) emit(node, `use case requires a corresponding quick test: ${testFile}`)
  } }
}

function sourceLineCount(source) {
  let text = source.text
  for (const comment of [...source.getAllComments()].reverse()) {
    const fragment = text.slice(comment.range[0], comment.range[1])
    text = `${text.slice(0, comment.range[0])}${fragment.replace(/[^\n]/gu, ' ')}${text.slice(comment.range[1])}`
  }
  return text.split('\n').filter(line => line.trim() !== '').length
}

function sizeVisitors({ file, source, emit }) {
  const limit = file.startsWith('src/') ? 500 : file.startsWith('admin-ui/src/') ? 600 : file.startsWith('tests/') ? 800 : undefined
  if (limit === undefined) return {}
  return { Program(node) {
    const count = sourceLineCount(source)
    if (count > limit) emit(node, `nonblank noncomment lines ${count} exceed ${limit}`)
  } }
}

function pluginSpecialCaseVisitors({ file, source, emit }) {
  if (!file.startsWith('src/')) return {}
  const identity = /\b(?:pluginId|pluginName|packageName|serviceId|serviceName|connectionId)\b|\b(?:plugin|service|connection)\??\.(?:id|name|packageName)\b/u
  const literalName = node => node?.type === 'Literal' && typeof node.value === 'string' && node.value.length > 0
  const inspect = node => {
    if (!identity.test(source.getText(node))) return
    if (node.left.type === 'UnaryExpression' && node.left.operator === 'typeof'
      || node.right.type === 'UnaryExpression' && node.right.operator === 'typeof') return
    if (node.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(node.operator)
      && (literalName(node.left) || literalName(node.right))) {
      emit(node, 'plugin or service identity cannot select core behavior by literal name')
    }
  }
  return {
    BinaryExpression: inspect,
    SwitchStatement(node) {
      if (!identity.test(source.getText(node.discriminant))) return
      for (const branch of node.cases) if (literalName(branch.test)) {
        emit(branch, 'plugin or service identity cannot select core behavior by literal name')
      }
    },
  }
}

export default { rules: {
  layer: ruleFactory('layer', 1, importVisitors),
  'error-message-branch': ruleFactory('error-message-branch', 3, messageVisitors),
  'dsh-seam': ruleFactory('dsh-seam', 4, seamVisitors),
  'io-exit': ruleFactory('io-exit', 5, ioVisitors),
  'admin-contract': ruleFactory('admin-contract', 7, contractVisitors),
  'use-case-test': ruleFactory('use-case-test', 8, useCaseTestVisitors),
  'file-size': ruleFactory('file-size', 'size', sizeVisitors),
  'plugin-special-case': ruleFactory('plugin-special-case', 8, pluginSpecialCaseVisitors),
} }
