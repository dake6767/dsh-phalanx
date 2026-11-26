import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECKER = join(ROOT, 'scripts/check-python-architecture.py')

function runChecker(root: string): { status: number; stderr: string } {
  try {
    execFileSync('python3', [CHECKER, '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number; stderr?: string | Buffer }
    return { status: failed.status ?? 1, stderr: String(failed.stderr ?? '') }
  }
}

async function withFixture(files: Record<string, string>, run: (root: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phalanx-py-arch-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = join(dir, rel)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const MINIMAL_BUILD_MJS = `const [
  bootstrap,
  compatibilitySource,
  questions,
] = await Promise.all([
  readFile(new URL('bootstrap.sh', directory), 'utf8'),
  readFile(new URL('installer_compatibility.py', directory), 'utf8'),
  readFile(new URL('installer_questions.py', directory), 'utf8'),
])
const compatibility = compatibilitySource.replace(/x/u, 'x')
const generated = [
  compatibility,
  questions,
]
  .map(source =>
    source.replace(
      /^[ \\t]*from installer_(?:compatibility|questions) import .*# embedded-(?:compatibility|questions)\\n/gmu,
      '',
    ),
  )
  .join('\\n')
`

describe('python architecture gate', () => {
  it('passes cleanly on the live repository tree', () => {
    const result = runChecker(ROOT)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('enforces syntax, undefined names, unused imports, unused locals, and explicit re-exports', async () => {
    await withFixture(
      {
        'scripts/install/installer_compatibility.py': [
          'import math as math',
          'def helper(unused_param):',
          '    _ignored = 1',
          '    return math.floor(1.5)',
          '',
        ].join('\n'),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture({ 'scripts/install/installer_compatibility.py': 'def broken(:\n    pass\n' }, dir => {
      const result = runChecker(dir)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('syntax error')
    })

    await withFixture(
      {
        'scripts/install/installer_compatibility.py': [
          'import json',
          'from math import *',
          'def sample():',
          '    dead = 1',
          '    return missing_symbol',
          '',
        ].join('\n'),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("unused import 'json'")
        expect(result.stderr).toContain('wildcard import is forbidden')
        expect(result.stderr).toContain("unused local variable 'dead'")
        expect(result.stderr).toContain("undefined name 'missing_symbol'")
      },
    )
  })

  it('forbids semicolons and inline compound statements with zero exceptions', async () => {
    await withFixture(
      {
        'scripts/install/installer_compatibility.py': [
          'def ok(flag):',
          '    mapping = {"a": 1}',
          '    if flag:',
          '        return mapping["a"] if flag else 0',
          '    elif not flag:',
          '        return 2',
          '    else:',
          '        return 3',
          '',
        ].join('\n'),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/install/installer_compatibility.py': [
          'class Marker: pass',
          'def inline_fn(x): return x',
          'def mixed(items, ctx):',
          '    a = 1; b = 2',
          '    if a: return b',
          '    elif b: return a',
          '    else: return 0',
          '    for item in items: pass',
          '    while a: break',
          '    with ctx: pass',
          '    try: inline_fn(Marker)',
          '    except Exception: pass',
          '    finally: pass',
          '',
        ].join('\n'),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('semicolon statement separator is forbidden')
        expect(result.stderr).toContain('inline compound statement (classdef)')
        expect(result.stderr).toContain('inline compound statement (functiondef)')
        expect(result.stderr).toContain('inline compound statement (if)')
        expect(result.stderr).toContain('inline compound statement (else)')
        expect(result.stderr).toContain('inline compound statement (for)')
        expect(result.stderr).toContain('inline compound statement (while)')
        expect(result.stderr).toContain('inline compound statement (with)')
        expect(result.stderr).toContain('inline compound statement (try)')
        expect(result.stderr).toContain('inline compound statement (except)')
        expect(result.stderr).toContain('inline compound statement (finally)')
      },
    )
  })

  it('enforces the 500-line code limit and executor-only size ratchet', async () => {
    const codeLines = (n: number) => Array.from({ length: n }, (_, i) => `VALUE_${i} = ${i}`).join('\n') + '\n'
    const executorFiles = JSON.stringify(['installer_host.py'])

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'scripts/install/installer_compatibility.py': '# comment\n\n'.repeat(30) + codeLines(500),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'scripts/install/installer_compatibility.py': codeLines(501),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('nonblank noncomment lines 501 exceed 500')
      },
    )

    const exemption = (file: string, maxLines: number) => JSON.stringify({ fileSize: { [file]: { maxLines, ticket: '0.1.44/01' } } })

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'architecture-exemptions.json': exemption('scripts/install/installer_host.py', 520),
        'scripts/install/installer_host.py': codeLines(520),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'architecture-exemptions.json': exemption('scripts/install/installer_host.py', 520),
        'scripts/install/installer_host.py': codeLines(521),
      },
      dir => {
        expect(runChecker(dir).stderr).toContain('exceed the ratcheted 520')
      },
    )

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'architecture-exemptions.json': exemption('scripts/install/installer_host.py', 520),
        'scripts/install/installer_host.py': codeLines(519),
      },
      dir => {
        expect(runChecker(dir).stderr).toContain('below the ratcheted 520; lower its maxLines to 519')
      },
    )

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'architecture-exemptions.json': exemption('scripts/install/installer_host.py', 520),
        'scripts/install/installer_host.py': codeLines(500),
      },
      dir => {
        expect(runChecker(dir).stderr).toContain('within 500; remove its size exemption')
      },
    )

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'architecture-exemptions.json': exemption('scripts/install/installer.py', 520),
        'scripts/install/installer.py': codeLines(520),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('only allowed for legacy executor modules')
        expect(result.stderr).toContain('nonblank noncomment lines 520 exceed 500')
      },
    )

    await withFixture(
      {
        'scripts/install/executor-files.json': executorFiles,
        'architecture-exemptions.json': exemption('scripts/dev/tool.py', 520),
        'scripts/dev/tool.py': codeLines(520),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('only allowed for legacy executor modules')
        expect(result.stderr).toContain('nonblank noncomment lines 520 exceed 500')
      },
    )
  })

  it('enforces the four-layer dependency model, L0 standalone, L1 purity, DAG acyclicity, and module registration', async () => {
    await withFixture(
      {
        'scripts/install/installer_compatibility.py': 'BASE = 1\n',
        'scripts/install/installer_questions.py': [
          'from urllib import parse',
          'from installer_compatibility import BASE',
          'def check(url):',
          '    return parse.urlparse(url).scheme, BASE',
          '',
        ].join('\n'),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/install/installer_upgrade_gate.py': ['from installer_compatibility import BASE', 'VALUE = BASE', ''].join('\n'),
        'scripts/install/installer_compatibility.py': [
          'import subprocess',
          'from urllib import request',
          'from installer_host import HOST_VAL',
          'BASE = 1',
          'def leak(path):',
          '    return subprocess, request, HOST_VAL, open(path)',
          '',
        ].join('\n'),
        'scripts/install/installer_host.py': [
          'from installer_upgrade_cli import CLI_VAL',
          'from installer_release import REL_VAL',
          'HOST_VAL = (CLI_VAL, REL_VAL)',
          '',
        ].join('\n'),
        'scripts/install/installer_release.py': ['from installer_host import HOST_VAL', 'REL_VAL = HOST_VAL', ''].join('\n'),
        'scripts/install/installer_upgrade_cli.py': 'CLI_VAL = 1\n',
        'scripts/install/installer_unregistered.py': 'X = 1\n',
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("L0 standalone module cannot import 'installer_compatibility'")
        expect(result.stderr).toContain("L1 pure module cannot import OS/network I/O module 'subprocess'")
        expect(result.stderr).toContain("L1 pure module cannot import OS/network I/O module 'urllib.request'")
        expect(result.stderr).toContain("L1 pure module cannot call 'open'")
        expect(result.stderr).toContain("L1 module cannot import L2 module 'installer_host'")
        expect(result.stderr).toContain("L2 module cannot import L3 module 'installer_upgrade_cli'")
        expect(result.stderr).toContain('dependency cycle: installer_host -> installer_release -> installer_host')
        expect(result.stderr).toContain('unregistered scripts/install module has no architecture layer')
      },
    )
  })

  it('enforces Law 3 against error-text branching while allowing declared display mappers', async () => {
    await withFixture(
      {
        'scripts/install/installer_progress.py': [
          'import re',
          'def operator_text(value, language):',
          '    if language != "zh-CN":',
          '        return value',
          '    if value.startswith("Running "):',
          '        return value',
          '    if re.fullmatch(r"x(.*)", value):',
          '        return value',
          '    return value',
          'def safe_presence(job):',
          '    if job.get("failure"):',
          '        return job["failure"]',
          '    return None',
          '',
        ].join('\n'),
        'scripts/install/installer_deployment_cli.py': [
          'import re',
          'def reason_text(value, language):',
          '    if language == "zh-CN" and re.fullmatch(r"err (.*)", value):',
          '        return value',
          '    return value',
          '',
        ].join('\n'),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/install/installer_progress.py': [
          'import re',
          'def bad_handler(fn, code):',
          '    captured: str = ""',
          '    try:',
          '        fn()',
          '    except ValueError as boom:',
          '        if "denied" in str(boom):',
          '            return 1',
          '        msg = str(boom)',
          '        if msg.startswith("timeout"):',
          '            return 2',
          '        is_timeout = "timeout" in str(boom)',
          '        if is_timeout:',
          '            return 3',
          '        matched = re.search("busy", str(boom))',
          '        if matched:',
          '            return 4',
          '        captured = str(boom)',
          '        match code:',
          '            case 1 if "denied" in str(boom):',
          '                return 5',
          '    if "late" in captured:',
          '        return 6',
          '    return 0',
          'def bad_attr(error):',
          '    if error.message == "x":',
          '        return 1',
          '    return 0',
          '',
        ].join('\n'),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        const matches = result.stderr.match(/law 3: business branch examines error or failure text/gu) ?? []
        expect(matches.length).toBeGreaterThanOrEqual(7)
      },
    )
  })

  it('validates install.sh concatenation topology, embedded import integrity, and global symbol uniqueness', async () => {
    await withFixture(
      {
        'scripts/install/build-installer.mjs': MINIMAL_BUILD_MJS,
        'scripts/install/installer_compatibility.py': 'BASE_TOKEN = "ok"\n',
        'scripts/install/installer_questions.py': [
          'from installer_compatibility import BASE_TOKEN  # embedded-compatibility',
          'def read_token():',
          '    return BASE_TOKEN',
          '',
        ].join('\n'),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/install/build-installer.mjs': MINIMAL_BUILD_MJS.replace('[\n  compatibility,\n  questions,\n]', '[\n  questions,\n  compatibility,\n]'),
        'scripts/install/installer_compatibility.py': 'SHARED = 1\n',
        'scripts/install/installer_questions.py': [
          'from installer_compatibility import MISSING as RENAMED  # embedded-compatibility',
          'SHARED = 2',
          'USED = RENAMED',
          '',
        ].join('\n'),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("install.sh global namespace collision for 'SHARED'")
        expect(result.stderr).toContain("concatenation order violates dependency on 'installer_compatibility'")
        expect(result.stderr).toContain('cannot rename symbol stripped in install.sh')
        expect(result.stderr).toContain("embedded import 'MISSING' is not exported by installer_compatibility.py")
      },
    )
    await withFixture(
      {
        'scripts/install/build-installer.mjs': MINIMAL_BUILD_MJS,
        'scripts/install/installer_compatibility.py': 'BASE_TOKEN = "ok"\n',
        'scripts/install/installer_executor_protocol.py': 'PROTO = 1\n',
        'scripts/install/installer_questions.py': [
          'import installer_compatibility',
          'from installer_compatibility import BASE_TOKEN  # embedded-compatibility  # trailing',
          'from installer_executor_protocol import PROTO',
          'USED = (installer_compatibility, BASE_TOKEN, PROTO)',
          '',
        ].join('\n'),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("bare 'import installer_compatibility' cannot be stripped in install.sh")
        expect(result.stderr).toContain('does not match build-installer.mjs strip pattern')
        expect(result.stderr).toContain("requires matching '# embedded-compatibility' marker")
        expect(result.stderr).toContain("concatenated module cannot import non-concatenated local module 'installer_executor_protocol'")
      },
    )
  })

  it('blocks restricted wording and hardcoded suite identities while allowing download-source infrastructure names', async () => {
    await withFixture(
      {
        'scripts/install/installer_compatibility.py': [
          'KEYS = ("PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", "browserChromiumArm64", "chromium_arm64_download_host", "--chromium-arm64-download-host")',
          '',
        ].join('\n'),
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/install/installer_compatibility.py': ['# \u5546\u4e1a\u7248\u8ba1\u8d39', 'TOOL = "officecli"', ''].join('\n'),
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('restricted product-tier wording is forbidden')
        expect(result.stderr).toContain('concrete suite identities belong in the signed online catalog')
      },
    )
  })

  it('applies tiered rules to scripts/dev and syntax-only checks to tests/fixtures', async () => {
    await withFixture(
      {
        'scripts/dev/helper.py': [
          'import subprocess',
          'def run_probe(error):',
          '    # officecli \u5546\u4e1a\u7248 allowed in dev harness',
          '    if "x" in str(error):',
          '        return subprocess.PIPE',
          '    return None',
          '',
        ].join('\n'),
        'tests/fixtures/sample.py': 'import os\ndef compact(x): a = 1; return x + a\n',
      },
      dir => {
        expect(runChecker(dir)).toEqual({ status: 0, stderr: '' })
      },
    )

    await withFixture(
      {
        'scripts/dev/helper.py': 'import os\ndef bad(): a = 1; return a\n',
        'tests/fixtures/broken.py': 'def oops(:\n    pass\n',
      },
      dir => {
        const result = runChecker(dir)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("scripts/dev/helper.py:1: unused import 'os'")
        expect(result.stderr).toContain('scripts/dev/helper.py:2: semicolon statement separator is forbidden')
        expect(result.stderr).toContain('scripts/dev/helper.py:2: inline compound statement (functiondef)')
        expect(result.stderr).toContain('tests/fixtures/broken.py:1: syntax error')
      },
    )
  })
})
