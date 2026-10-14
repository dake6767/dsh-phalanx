/** Official per-call shell environment: member gateway access, never platform credentials. */
export const executionShellEnvironment = `
export const name = 'phalanx-execution-shell-environment'
export const inject = ['shellEnv']
export function apply(ctx) {
  ctx.shellEnv.register({
    name: 'phalanx-member-gateway',
    variables: {
      DSH_PHALANX_MODEL_GATEWAY_URL: { description: 'Platform gateway for this member.' },
      DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: { description: 'Member-scoped gateway access; platform credentials remain server-side.' },
    },
    resolve: () => Object.fromEntries(['DSH_PHALANX_MODEL_GATEWAY_URL', 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN']
      .flatMap(key => typeof process.env[key] === 'string' ? [[key, process.env[key]]] : [])),
  })
}
`
