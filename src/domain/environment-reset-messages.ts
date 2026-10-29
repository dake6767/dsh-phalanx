export const en = {
  'Reset DSH environment': 'Reset DSH environment',
  'This resets DSH configuration and self-installed plugins.': 'This resets DSH configuration and self-installed plugins.',
  'Projects, conversations and other personal files are preserved.': 'Projects, conversations and other personal files are preserved.',
  'Member reset requests are limited to once every 10 minutes. Administrators are exempt.':
    'Member reset requests are limited to once every 10 minutes. Administrators are exempt.',
  'To recover an older configuration, contact an administrator.': 'To recover an older configuration, contact an administrator.',
  'The latest three complete environment backups are retained per member.': 'The latest three complete environment backups are retained per member.',
  'I understand that tasks will be interrupted and my configuration and self-installed plugins will be reset.':
    'I understand that tasks will be interrupted and my configuration and self-installed plugins will be reset.',
  'Resetting your DSH environment…': 'Resetting your DSH environment…',
  'DSH environment reset. Your projects, conversations and files are preserved.':
    'DSH environment reset. Your projects, conversations and files are preserved.',
  'Reset failed. {error}': 'Reset failed. {error}',
  'Last environment reset requested': 'Last environment reset requested',
  'Requested by administrator {username} at {time}.': 'Requested by administrator {username} at {time}.',
  'Requested by member {username} at {time}.': 'Requested by member {username} at {time}.',
} as const
export const zhCN = {
  'Reset DSH environment': '重置 DSH 环境',
  'This resets DSH configuration and self-installed plugins.': '这会重置 DSH 配置和自行安装的插件。',
  'Projects, conversations and other personal files are preserved.': '项目、聊天记录和其他个人文件会保留。',
  'Member reset requests are limited to once every 10 minutes. Administrators are exempt.': '成员每 10 分钟最多发起一次重置，管理员不受此限制。',
  'To recover an older configuration, contact an administrator.': '如需找回旧配置，请联系管理员。',
  'The latest three complete environment backups are retained per member.': '每个成员保留最近 3 份完整环境备份。',
  'I understand that tasks will be interrupted and my configuration and self-installed plugins will be reset.':
    '我已了解，任务会中断，配置和自行安装的插件会被重置。',
  'Resetting your DSH environment…': '正在重置 DSH 环境…',
  'DSH environment reset. Your projects, conversations and files are preserved.': 'DSH 环境已重置，项目、聊天记录和文件已保留。',
  'Reset failed. {error}': '重置失败。{error}',
  'Last environment reset requested': '最近一次环境重置发起记录',
  'Requested by administrator {username} at {time}.': '管理员 {username} 于 {time} 发起。',
  'Requested by member {username} at {time}.': '成员本人 {username} 于 {time} 发起。',
} satisfies Record<keyof typeof en, string>
