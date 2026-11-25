import { expect, it } from 'vitest'
import { runAsyncCommand } from './support/async-command.js'

const runPython = (script: string, timeout = 28_000) => runAsyncCommand('python3', [script], { timeout })

it.concurrent(
  'admits Debian-family hosts through the installation command and reports verification and capability failures',
  async () => {
    const result = await runPython('tests/fixtures/installer-hosts.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'uses saved download sources and rejects bad proxy bytes through the installation and upgrade CLI',
  async () => {
    const result = await runPython('tests/fixtures/installer-download-sources.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'requires explicit development opt-in for native arm64 installation',
  async () => {
    const result = await runPython('tests/fixtures/installer-development.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'honors the installation command contract at filesystem and operating-system I/O',
  async () => {
    const result = await runPython('tests/fixtures/installer-contract.py')
    expect(result.stderr, result.stdout).not.toContain('Traceback')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'guides retries and preserves terminal input with heredoc source',
  async () => {
    const result = await runPython('tests/fixtures/installer-experience.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'shows live progress and keeps machine output and diagnostics safe',
  async () => {
    const result = await runPython('tests/fixtures/installer-output.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'coalesces human progress while retaining CLI and Web facts, and preserves real PTY summaries',
  async () => {
    const result = await runPython('tests/fixtures/installer-progress-rendering.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'discovers stable releases and development candidates using only verified release assets',
  async () => {
    const result = await runPython('tests/fixtures/installer-release-assets.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'uses a protected authenticated CONNECT proxy for installation, updates and product-user pulls',
  async () => {
    const result = await runPython('tests/fixtures/installer-egress-proxy.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'prepares a digest-verified rootless PostgreSQL service and private bootstrap configuration',
  async () => {
    const result = await runPython('tests/fixtures/installer-database.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'runs the shared bilingual installation flow, rechecks sources and retains hidden explicit configuration',
  async () => {
    const result = await runPython('tests/fixtures/installer-bilingual.py')
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)
