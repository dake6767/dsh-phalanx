import { expect, it } from 'vitest'
import { contributionCommandFindings } from '../src/domain/contribution-commands.js'
it('finds plain CLI invocations in inline documentation and after shell separators without splitting quoted arguments', () => {
  const files = new Map([
    ['SKILL.md', 'Run `officecli read report.xlsx` and `python3 helper.py`.'],
    ['script.sh', 'printf hello | officecli read\nprintf "text | quoted-fake"; lark-cli docs list && mmx query'],
  ])
  const findings = contributionCommandFindings(files, { purpose: 'Documents' }, ['python3'])
  expect(findings.map(row => [row.path, row.advice.match(/command (\S+)/u)?.[1]])).toEqual([['SKILL.md', 'officecli'], ['script.sh', 'lark-cli'], ['script.sh', 'mmx'], ['script.sh', 'officecli']])
})

it('does not interpret shell file-descriptor redirection as a command', () => {
  expect(contributionCommandFindings(new Map([['script.sh', 'printf "🤖" 2>&1\nprintf hello 2>&1\nprintf hello &>/dev/null\nread value 3<&0']]), { purpose: 'Print' }, [])).toEqual([])
})
