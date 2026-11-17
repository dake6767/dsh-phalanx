import { withSuiteCatalogContentHash } from '../../src/domain/suite-catalog-document.js'

export function signedMcpEntries(version = '1.0.0') {
  const base = { kind: 'mcp' as const, engines: { platform: '>=0.1.37' } }
  return [
    withSuiteCatalogContentHash({
      ...base,
      id: 'amap',
      version,
      title: { en: 'Amap', 'zh-CN': '高德地图' },
      description: { en: 'Maps, routes and weather', 'zh-CN': '地点搜索、路线规划与天气查询' },
      source: { en: 'Amap', 'zh-CN': '高德地图' },
      documentation: 'https://lbs.amap.com/api/mcp-server/gettingstarted',
      adapters: [
        {
          name: 'mcp-remote-http',
          params: {
            url: 'https://mcp.amap.com/mcp',
            credential: { label: { en: 'Amap Web Service Key', 'zh-CN': '高德 Web 服务 Key' }, in: 'query', name: 'key', template: '{credential}' },
          },
        },
      ],
    }),
    withSuiteCatalogContentHash({
      ...base,
      id: '12306',
      version: '1.0.0',
      title: { en: '12306', 'zh-CN': '12306' },
      description: { en: 'Train schedules, stations and available tickets', 'zh-CN': '列车时刻、车站与余票查询' },
      source: { en: '12306', 'zh-CN': '12306' },
      documentation: 'https://github.com/Joooook/12306-mcp',
      adapters: [
        {
          name: 'mcp-shared-node',
          params: {
            repository: 'Joooook/12306-mcp',
            commit: '2ea7a601a2af0e1cc48b8235e65fa11f1af55aaf',
            sha256: '50b59dfb73fceb28fd3c688ae861cb9f6f73a91cb7ee23c5048cae75bdb994bc',
            script: 'build/index.js',
          },
        },
      ],
    }),
  ]
}
