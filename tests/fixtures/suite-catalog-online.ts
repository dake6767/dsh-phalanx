import { withSuiteCatalogContentHash, type SuiteCatalogDocumentEntry, type UnsealedSuiteCatalogDocumentEntry } from '../../src/domain/suite-catalog-document.js'

const text = (en: string, zhCN: string = en) => ({ en, 'zh-CN': zhCN })
const wecomSkills = ['wecomcli-calendar', 'wecomcli-contact', 'wecomcli-disk', 'wecomcli-doc', 'wecomcli-doc-manage', 'wecomcli-email', 'wecomcli-media', 'wecomcli-meeting', 'wecomcli-message', 'wecomcli-pptx', 'wecomcli-shared', 'wecomcli-sheet', 'wecomcli-smartpage', 'wecomcli-smartsheet', 'wecomcli-todo'] as const

/** The four 0.1.18 entries that only need base fields, described declaratively with the published hashes. */
const unsealed: readonly UnsealedSuiteCatalogDocumentEntry[] = [
  {
    kind: 'dependency', id: 'pandoc', version: '3.12.1', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('pandoc'), description: text('Universal document converter for Markdown, Word, PDF and more', '通用文档转换器，支持 Markdown、Word、PDF 等格式'),
    source: text('GitHub release jgm/pandoc 3.12.1, static build', 'GitHub Release jgm/pandoc 3.12.1 静态构建'),
    items: [{
      kind: 'runtime-dependency', name: 'pandoc', paths: ['bin'], commands: ['pandoc'], check: { command: 'pandoc', args: ['--version'] },
      downloads: [{
        source: 'github-assets', url: 'https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-{arch}.tar.gz',
        sha256: { amd64: 'd0c90410e90204c9ca83b8539fac5c7aed01fd537207e4585849f8abc5df20b8', arm64: '445d96fd08801fe636cab1158b4f017ee320ac3b7446328b4fe2f902117b19b9' },
        target: 'pandoc.tar.gz', extract: { format: 'tar', directory: 'bin', stripComponents: 2, member: 'pandoc-3.12.1/bin/pandoc' },
      }],
    }],
  },
  {
    kind: 'dependency', id: 'ffmpeg', version: '7.0.2', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('FFmpeg'), description: text('Audio and video encoding with ffmpeg and ffprobe, shared by the suites that need it', '音视频编解码工具 ffmpeg 与 ffprobe，供需要它的套件共用'),
    source: text('GitHub release eugeneware/ffmpeg-static b6.1.1, ffmpeg 7.0.2 static build (GPL)', 'GitHub Release eugeneware/ffmpeg-static b6.1.1，ffmpeg 7.0.2 静态构建（GPL）'),
    items: [{
      kind: 'runtime-dependency', name: 'ffmpeg', paths: ['bin'], commands: ['ffmpeg', 'ffprobe'], check: { command: 'ffmpeg', args: ['-hide_banner', '-version'] },
      downloads: [
        { source: 'github-assets', url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-{nodeArch}',
          sha256: { amd64: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99', arm64: '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce' },
          target: 'bin/ffmpeg', executable: true, timeout: { connectSeconds: 15, totalSeconds: 600 } },
        { source: 'github-assets', url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-{nodeArch}',
          sha256: { amd64: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d', arm64: 'd17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8' },
          target: 'bin/ffprobe', executable: true, timeout: { connectSeconds: 15, totalSeconds: 600 } },
      ],
    }],
  },
  {
    kind: 'dependency', id: 'chromium', version: '153.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('Chromium headless shell', 'Chromium 无头浏览器'), description: text('Headless Chromium for rendering and capture, shared by the suites that need it', '用于渲染与截取的无头 Chromium，供需要它的套件共用'),
    source: text('Playwright chromium-headless-shell (amd64: Chrome for Testing 153.0.8010.12; arm64: Chromium build 1243) through the browser download source',
      '经浏览器下载源取得的 Playwright chromium-headless-shell（amd64：Chrome for Testing 153.0.8010.12；arm64：Chromium 构建 1243）'),
    items: [{
      kind: 'runtime-dependency', name: 'chromium', paths: ['bin'], commands: ['chromium-headless-shell'], check: { command: 'chromium-headless-shell', args: ['--version'] },
      entry: { amd64: 'lib/chrome-headless-shell-linux64/chrome-headless-shell', arm64: 'lib/chrome-linux/headless_shell' },
      downloads: [{
        source: 'browser',
        url: { amd64: 'builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip', arm64: 'builds/chromium/1243/chromium-headless-shell-linux-arm64.zip' },
        sha256: { amd64: 'a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d', arm64: '3a2bc2c354fb66615ee329c2ab13cd1312b40294798bea04c5dc0053caa6b881' },
        target: 'chromium.zip', extract: { format: 'zip', directory: 'lib' }, timeout: { connectSeconds: 15, totalSeconds: 900 },
      }],
    }],
  },
  {
    kind: 'suite', id: 'wecom', version: '1.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('WeCom', '企业微信'), description: text('Contacts, documents, sheets, calendar, meetings, mail and messages in WeCom as the signed-in member', '以成员本人身份使用企业微信的通讯录、文档、表格、日程、会议、邮件与消息'),
    source: text('npm @wecom/cli 1.3.4 and skills pinned to WecomTeam/wecom-cli commit f9b28151 (v1.3.4)', 'npm @wecom/cli 1.3.4，技能锁定 WecomTeam/wecom-cli 提交 f9b28151（v1.3.4）'),
    identity: text('Each member signs in as themselves: run `wecom-cli auth init` in the terminal and scan the QR code with WeCom, then check with `wecom-cli auth show --status`. The platform stores no credential; the encrypted sign-in stays in the member home.',
      '成员以本人身份登录：在终端执行 `wecom-cli auth init`，用企业微信扫码授权，再用 `wecom-cli auth show --status` 确认。平台不存储任何凭据，加密的登录信息只留在成员自己的 home。'),
    dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'wecom-tools', paths: ['node_modules/.bin'], commands: ['wecom-cli'], check: { command: 'wecom-cli', args: ['--version'] },
        downloads: [{ source: 'npm', packages: ['@wecom/cli@1.3.4', '@wecom/cli-linux-{nodeArch}@1.3.4'] }] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/WecomTeam/wecom-cli', commit: 'f9b28151dc8d42f703db624fc9b26723c3c93fc5', path: 'skills' }, names: [...wecomSkills], runtimeDependency: 'wecom-tools' },
      { kind: 'skill-pack', name: 'wecom', description: 'WeCom skills with the wecom-cli CLI provided by the platform; each member signs in as themselves.',
        note: 'The wecom-cli CLI is provided by the platform on PATH. Do not run `npm install -g @wecom/cli` or upgrade it. Each member signs in personally: if `wecom-cli auth show --status` is unauthorized, do not run `wecom-cli auth init` yourself; ask the member to run it in their own terminal and scan the QR code with WeCom, then check the status again. These two rules replace the install and initialization steps in wecomcli-shared; keep the other upstream task instructions.',
        skills: [...wecomSkills] },
    ],
  },
]

export const onlineCatalogEntries: readonly SuiteCatalogDocumentEntry[] = unsealed.map(withSuiteCatalogContentHash)

/** The preparation commands 0.1.18 shipped; the generated equivalents must match byte for byte where the style allows. */
export const legacyPrepareCommands: Readonly<Record<string, Readonly<Record<'amd64' | 'arm64', string>>>> = {
  pandoc: {
    amd64: 'curl --fail --location --silent --show-error "${GITHUB_ASSETS_PREFIX}https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-amd64.tar.gz" -o pandoc.tar.gz && echo "d0c90410e90204c9ca83b8539fac5c7aed01fd537207e4585849f8abc5df20b8  pandoc.tar.gz" | sha256sum -c - && mkdir -p bin && tar xzf pandoc.tar.gz --strip-components=2 -C bin pandoc-3.12.1/bin/pandoc && rm pandoc.tar.gz',
    arm64: 'curl --fail --location --silent --show-error "${GITHUB_ASSETS_PREFIX}https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-arm64.tar.gz" -o pandoc.tar.gz && echo "445d96fd08801fe636cab1158b4f017ee320ac3b7446328b4fe2f902117b19b9  pandoc.tar.gz" | sha256sum -c - && mkdir -p bin && tar xzf pandoc.tar.gz --strip-components=2 -C bin pandoc-3.12.1/bin/pandoc && rm pandoc.tar.gz',
  },
  ffmpeg: {
    amd64: `set -eu\nmkdir -p bin\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64" -o bin/ffmpeg\necho "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99  bin/ffmpeg" | sha256sum -c -\nchmod +x bin/ffmpeg\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-x64" -o bin/ffprobe\necho "4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d  bin/ffprobe" | sha256sum -c -\nchmod +x bin/ffprobe`,
    arm64: `set -eu\nmkdir -p bin\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-arm64" -o bin/ffmpeg\necho "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce  bin/ffmpeg" | sha256sum -c -\nchmod +x bin/ffmpeg\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-arm64" -o bin/ffprobe\necho "d17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8  bin/ffprobe" | sha256sum -c -\nchmod +x bin/ffprobe`,
  },
  chromium: {
    amd64: `set -eu\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "\${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip" -o chromium.zip\necho "a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d  chromium.zip" | sha256sum -c -\nmkdir -p lib bin\nunzip -q chromium.zip -d lib\nrm chromium.zip\nln -s ../lib/chrome-headless-shell-linux64/chrome-headless-shell bin/chromium-headless-shell`,
    arm64: `set -eu\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "\${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/chromium/1243/chromium-headless-shell-linux-arm64.zip" -o chromium.zip\necho "3a2bc2c354fb66615ee329c2ab13cd1312b40294798bea04c5dc0053caa6b881  chromium.zip" | sha256sum -c -\nmkdir -p lib bin\nunzip -q chromium.zip -d lib\nrm chromium.zip\nln -s ../lib/chrome-linux/headless_shell bin/chromium-headless-shell`,
  },
  wecom: {
    amd64: 'set -eu\nnpm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund @wecom/cli@1.3.4 @wecom/cli-linux-x64@1.3.4',
    arm64: 'set -eu\nnpm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund @wecom/cli@1.3.4 @wecom/cli-linux-arm64@1.3.4',
  },
}
