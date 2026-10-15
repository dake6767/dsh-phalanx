import type { CommunityMcpInput } from '../../src/domain/admin-contract.js'

// Official Bocha source and its committed uv.lock; preparation never rewrites upstream code.
export const bochaSample: CommunityMcpInput = {
  name: 'p-bocha', description: 'Official Bocha shared stdio', url: '',
  run: { location: 'shared', command: '.venv/bin/bocha-search-mcp', args: [],
    env: [{ name: 'BOCHA_API_KEY', value: '{credential}' }],
    prepareCommand: [
      'pip install --disable-pip-version-check --no-cache-dir --target .bootstrap uv==0.9.4',
      'curl --fail --location --silent --show-error https://codeload.github.com/BochaAI/bocha-search-mcp/tar.gz/285bf4064a3317ad0f29966da8af5e1fdace14f1 -o source.tar.gz',
      'echo "a80682628b22d2f43433e4141f2e9124e5c8763a31849ccdcdd3820159460449  source.tar.gz" | sha256sum -c -',
      'mkdir source && tar xzf source.tar.gz -C source --strip-components=1',
      'UV_PYTHON_INSTALL_DIR="$PWD/python-runtime" UV_PROJECT_ENVIRONMENT="$PWD/.venv" UV_CACHE_DIR="$PWD/.uv-cache" .bootstrap/bin/uv sync --frozen --no-dev --no-editable --project source --python 3.12.12',
      'rm -rf .bootstrap .uv-cache source.tar.gz',
    ].join(' && '),
  },
}
export const amapSample: CommunityMcpInput = {
  name: 'p-amap', description: 'Official Amap remote query authentication', url: 'https://mcp.amap.com/mcp',
  query: [{ name: 'key', value: '{credential}' }],
}

export const githubSample: CommunityMcpInput = {
  name: 'p-github', description: 'Official GitHub remote PAT', url: 'https://api.githubcopilot.com/mcp/',
  headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
}
export const context7Sample: CommunityMcpInput = {
  name: 'p-context7', description: 'Documentation', url: 'https://mcp.context7.com/mcp',
}
export const playwrightSample: CommunityMcpInput = {
  name: 'p-browser', description: 'Prepared member browser', url: '',
  run: { location: 'member', command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.80', '--headless', '--no-sandbox', '--browser', 'chromium', '--allow-unrestricted-file-access', '--output-dir', '/dsh-phalanx/workspace'],
    env: [{ name: 'PLAYWRIGHT_BROWSERS_PATH', value: '{dependencies}/browsers' }],
    // The pinned MCP's chromium channel uses full Chrome, not the separate headless shell.
    prepareCommand: 'npm install --ignore-scripts --no-audit --no-fund --cache .npm-cache --save-exact @playwright/mcp@0.0.80 && PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" node node_modules/playwright/cli.js install chromium --no-shell && rm -rf .npm-cache',
  },
}
