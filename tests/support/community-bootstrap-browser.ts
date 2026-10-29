import type { Page } from 'playwright'

/** Keep the default for fresh installs; seeded fixtures have already selected their database. */
export async function selectBuiltinDatabase(page: Page): Promise<void> {
  const database = page.getByRole('heading', { name: /^(Platform database|平台数据库)$/u })
  const administrator = page.getByRole('button', { name: /^(Create administrator|创建管理员)$/u })
  await database.or(administrator).waitFor()
  if (await administrator.isVisible()) return
  await page.getByRole('button', { name: /^(Continue|继续)$/u }).click()
  await administrator.waitFor()
}
