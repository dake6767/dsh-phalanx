import ts from 'typescript'

/** Inspect ordinary and generated browser JavaScript with the same syntax rules. */
export function browserHttpViolations(text) {
  const failures = new Set()
  const member = node =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined
  const named = (node, name) => (ts.isIdentifier(node) && node.text === name) || member(node) === name
  const hasCopy = node => {
    let found = false
    const visit = child => {
      if (
        ts.isCallExpression(child) &&
        member(child.expression) === 'execCommand' &&
        named(child.expression.expression, 'document') &&
        child.arguments[0] &&
        ts.isStringLiteral(child.arguments[0]) &&
        child.arguments[0].text === 'copy'
      )
        found = true
      ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }
  const clipboardFallback = node => {
    let awaited = false
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isAwaitExpression(parent)) awaited = true
      if (ts.isFunctionLike(parent)) return false
      if (ts.isTryStatement(parent) && node.pos >= parent.tryBlock.pos && node.end <= parent.tryBlock.end) {
        return awaited && Boolean(parent.catchClause && hasCopy(parent.catchClause.block))
      }
    }
    return false
  }
  const inspect = (source, depth = 0) => {
    const root = ts.createSourceFile('browser.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      const name = member(node)
      if (name && ['randomUUID', 'subtle'].includes(name) && named(node.expression, 'crypto')) {
        failures.add('browser code must work on insecure HTTP; use an HTTP-compatible capability')
      }
      if (name === 'clipboard' && named(node.expression, 'navigator') && !clipboardFallback(node)) {
        failures.add('clipboard access needs an awaited try/catch with an HTTP-compatible copy fallback')
      }
      if (depth < 8) {
        const generated = ts.isTemplateExpression(node)
          ? node.head.text + node.templateSpans.map(span => 'null' + span.literal.text).join('')
          : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            ? node.text
            : undefined
        if (generated && /crypto|navigator/u.test(generated)) inspect(generated, depth + 1)
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
  }
  inspect(text)
  return [...failures]
}
