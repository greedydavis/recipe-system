import { expect, test } from '@playwright/test';
import { loginAs, nav, openVersion } from './helpers';

// CLAUDE.md §7 的主要流程；資料都是 src/data/demoSeed.ts 的虛構示範資料

test('建立菜品並送試菜、建立試菜場次', async ({ page }) => {
  await loginAs(page, '示範主廚');
  await nav(page, '食譜');
  await page.getByRole('button', { name: '新增' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('名稱', { exact: true }).fill('E2E 涼麵');
  await sheet.getByLabel('菜單分類', { exact: true }).fill('涼麵');
  await sheet.getByRole('button', { name: '建立並編輯 v1 草案' }).click();

  await expect(page.getByRole('heading', { name: '編輯 E2E 涼麵 v1' })).toBeVisible();
  await page.getByRole('button', { name: '原物料' }).click();
  await page.getByRole('button', { name: /生麵條（示範）/ }).click();
  await page.getByLabel('生麵條（示範） 用量').fill('150');
  await page.getByRole('button', { name: '儲存草案' }).click();
  await expect(page.getByRole('button', { name: '已儲存' })).toBeVisible();

  await page.getByRole('button', { name: '返回', exact: true }).last().click();
  await page.getByRole('button', { name: '送試菜' }).click();
  await page.getByRole('button', { name: '確認送試菜' }).click();
  await expect(page.getByRole('heading', { name: /E2E 涼麵 v1/ }).getByText('試菜中')).toBeVisible();

  await nav(page, '試菜');
  await page.getByRole('link', { name: '建立場次' }).click();
  await page.getByLabel('標題', { exact: true }).fill('E2E 第一輪');
  await page.getByRole('button', { name: '加入版本' }).click();
  await page.getByRole('button', { name: /E2E 涼麵/ }).click();
  await page.getByRole('button', { name: /^v1/ }).click();
  await page.getByRole('button', { name: '建立場次', exact: true }).click();
  await expect(page.getByRole('link', { name: 'E2E 涼麵 v1' })).toBeVisible();
});

test('核准定版：資料庫寫入成本快照', async ({ page }) => {
  await loginAs(page, '示範創辦人');
  await openVersion(page, '招牌湯麵（示範）', 1);
  await page.getByRole('button', { name: '送核准' }).click();
  const confirm = page.getByRole('button', { name: '確認送核准' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('送審說明').fill('E2E 送審');
  await confirm.click();

  await page.getByRole('button', { name: '核准定版' }).click();
  await page.getByRole('button', { name: '確認核准定版' }).click();
  await expect(page.getByText('已定版，內容不可修改')).toBeVisible();
  await page.getByRole('tab', { name: '成本' }).click();
  const snapshot = page.getByRole('heading', { name: '定版時成本快照' }).locator('xpath=ancestor::section[1]');
  await expect(snapshot).toContainText('$27.2');
  await expect(snapshot).toContainText('31.8%');
});

test('修改已定版食譜：只能複製成新草案，舊定版不變', async ({ page }) => {
  await loginAs(page, '示範主廚');
  await openVersion(page, '招牌湯底（示範）', 1, '元件');
  await expect(page.getByText('已定版，內容不可修改')).toBeVisible();
  await expect(page.getByRole('link', { name: '編輯草案' })).toHaveCount(0);

  await page.getByRole('button', { name: '複製為新版本' }).click();
  await expect(page.getByRole('heading', { name: '編輯 招牌湯底（示範） v2' })).toBeVisible();
  await page.getByLabel('豬大骨（示範） 用量').fill('12000');
  await page.getByRole('button', { name: '儲存草案' }).click();
  await expect(page.getByRole('button', { name: '已儲存' })).toBeVisible();

  await nav(page, '食譜');
  await page.getByRole('tab', { name: /元件/ }).click();
  await page.getByRole('link', { name: /招牌湯底（示範）/ }).click();
  await expect(page.getByRole('link', { name: /^v2/ })).toContainText('草案');
  await expect(page.getByRole('link', { name: /^v1/ })).toContainText('已定版');
});

test('更新原物料價格：成本用新的單價', async ({ page }) => {
  await loginAs(page, '示範店長');
  await nav(page, '原物料');
  await page.getByRole('link', { name: /豬大骨（示範）/ }).click();
  await expect(page.getByRole('heading', { name: '豬大骨（示範）', level: 1 })).toBeVisible();
  const currentPrice = page.getByText('目前單價').locator('..');
  await expect(currentPrice).toContainText('$60.00/kg');
  await page.getByRole('button', { name: '新增報價' }).click();
  await page.getByRole('dialog').getByLabel('金額（元）').fill('1500');
  await page.getByRole('dialog').getByRole('button', { name: '儲存' }).click();
  await expect(currentPrice).toContainText('$75.00/kg');
});

test('內場查看標準卡：份量換算、不顯示成本、可以列印', async ({ page }) => {
  await loginAs(page, '示範店長');
  await openVersion(page, '招牌湯底（示範）', 1, '元件');
  await page.getByRole('link', { name: /標準卡/ }).click();
  await page.getByRole('radio', { name: '10 份' }).click();
  // 10 份 × 420 g ＝ 4,200 g，是批次 21,000 g 的 0.2 倍：豬大骨 10,000 g → 2,000 g
  const card = page.locator('article');
  await expect(card).toContainText('×0.2');
  await expect(card.getByRole('row', { name: /豬大骨/ })).toContainText('2,000 g');
  await expect(card.getByRole('columnheader', { name: '成本' })).toHaveCount(0);
  await expect(page.getByText('含成本（創辦人）')).toHaveCount(0);

  await page.evaluate(() => {
    const w = window as unknown as { printed: boolean };
    w.printed = false;
    window.print = () => {
      w.printed = true;
    };
  });
  await page.getByRole('button', { name: '列印' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: boolean }).printed)).toBe(true);
});

test('測試人員評分：只看到指派給自己的項目', async ({ page }) => {
  await loginAs(page, '示範試吃員乙');
  await nav(page, '試菜');
  await expect(page.getByRole('link', { name: '建立場次' })).toHaveCount(0);
  const task = page.getByRole('link', { name: /招牌湯麵（示範）/ });
  await expect(task).toContainText('待評分');
  await task.click();
  await page.getByRole('radiogroup', { name: '整體分數' }).getByRole('radio', { name: '4' }).click();
  await page.getByRole('button', { name: '送出評分' }).click();
  await expect(page.getByRole('link', { name: /招牌湯麵（示範）/ })).toContainText('已評 4 分');
});
