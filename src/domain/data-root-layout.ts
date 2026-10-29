/** DATA_ROOT contains only replaceable artifacts, projections and transient runtime state. */
export const dataRootLayout = {
  artifacts: [
    'skills/artifacts',
    'skills/git-intake',
    'plugins/uploads/incoming',
    'plugins/uploads/archives',
    'plugins/artifacts',
    'plugins/staging',
    'contributions/artifacts',
    'contributions/plugin-intake',
    'runtime-dependencies/.trees',
  ],
  projections: ['skills/members', 'plugins/instances', 'experts/members', 'mcp/members', 'managed-models', 'platform-plugin'],
  runtime: ['execution/runner', 'execution/python-libraries', 'mcp/dependencies'],
  files: ['platform.lock', 'bootstrap-credential'],
} as const
