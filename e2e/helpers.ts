import { type Page, expect } from '@playwright/test';

export type DemoUser = '示範創辦人' | '示範主廚' | '示範店長' | '示範試吃員甲' | '示範試吃員乙';

/** 開啟網站（第一次會在瀏覽器建立示範資料庫，約 10–20 秒）並以示範帳號登入 */
export async function loginAs(page: Page, user: DemoUser) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(user) }).click({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: `你好，${user}` })).toBeVisible();
}

/** 底部主選單 */
export async function nav(page: Page, label: '首頁' | '食譜' | '試菜' | '原物料' | '更多') {
  await page.getByRole('navigation', { name: '主選單' }).getByRole('link', { name: label }).click();
}

/** 從食譜清單點進某個食譜，再點進某個版本 */
export async function openVersion(page: Page, recipe: string, versionNo: number, type: '菜品' | '元件' = '菜品') {
  await nav(page, '食譜');
  if (type === '元件') await page.getByRole('tab', { name: /元件/ }).click();
  await page.getByRole('link', { name: new RegExp(recipe) }).first().click();
  await page.getByRole('link', { name: new RegExp(`^v${versionNo}`) }).click();
}
