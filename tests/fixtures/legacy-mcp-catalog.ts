import type { CommunityMcpCatalogEntry } from '../../src/domain/admin-contract.js'
import type { McpPreset } from '../../src/domain/mcp-catalog.js'

/** Versioned platform presets; installed services retain their adopted configuration. */
export const mcpCatalog: readonly CommunityMcpCatalogEntry[] = [
  {
    id: 'amap',
    version: '1',
    title: { en: 'Amap', 'zh-CN': '高德地图' },
    description: { en: 'Maps, routes and weather', 'zh-CN': '地点搜索、路线规划与天气查询' },
    location: 'remote',
    credentialLabel: { en: 'Amap Web Service Key', 'zh-CN': '高德 Web 服务 Key' },
    documentation: 'https://lbs.amap.com/api/mcp-server/gettingstarted',
    imported: 0,
  },
  {
    id: '12306',
    version: '1',
    title: { en: '12306', 'zh-CN': '12306' },
    description: { en: 'Train schedules, stations and available tickets', 'zh-CN': '列车时刻、车站与余票查询' },
    location: 'shared',
    documentation: 'https://github.com/Joooook/12306-mcp',
    imported: 0,
  },
]
// Author's v0.3.10 commit includes built JavaScript and the complete npm lockfile.
const trainPreparation = [
  'curl --fail --location --silent --show-error https://codeload.github.com/Joooook/12306-mcp/tar.gz/2ea7a601a2af0e1cc48b8235e65fa11f1af55aaf -o source.tar.gz',
  'echo "50b59dfb73fceb28fd3c688ae861cb9f6f73a91cb7ee23c5048cae75bdb994bc  source.tar.gz" | sha256sum -c -',
  'mkdir source && tar xzf source.tar.gz -C source --strip-components=1',
  'npm ci --prefix source --omit=dev --ignore-scripts --no-audit --no-fund',
  'rm source.tar.gz',
].join(' && ')
export const mcpPresets: readonly McpPreset[] = mcpCatalog.map(entry => ({
  entry,
  configuration:
    entry.id === '12306'
      ? {
          description: '12306',
          url: '',
          run: { location: 'shared', command: 'node', args: ['{dependencies}/source/build/index.js'], env: [], prepareCommand: trainPreparation },
        }
      : { description: 'Amap', url: 'https://mcp.amap.com/mcp', run: null, headers: [], query: [{ name: 'key', value: '{credential}' }] },
}))
