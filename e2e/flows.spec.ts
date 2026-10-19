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

test('開店時間表：新增項目、拖拉改日期', async ({ page }) => {
  await loginAs(page, '示範創辦人');
  await page.getByRole('link', { name: /開店時間表/ }).click();
  await expect(page.getByRole('heading', { name: '開店時間表', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: '新增' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('項目名稱').fill('E2E 招牌安裝');
  await sheet.getByLabel('分類').fill('裝潢');
  await sheet.getByLabel('開始日期').fill('2026-09-08');
  await sheet.getByLabel('結束日期').fill('2026-09-10');
  await sheet.getByLabel('開始時間（選填）').fill('09:00');
  await sheet.getByLabel('結束時間（選填）').fill('17:30');
  await expect(sheet.getByText('共 3 天')).toBeVisible();
  await sheet.getByRole('button', { name: '儲存' }).click();
  const bar = page.getByRole('button', { name: /^E2E 招牌安裝 9\/8 09:00–9\/10 17:30（3 天）/ });
  await expect(bar).toBeVisible();

  // 手機預設不能拖（避免捲動時誤觸）；開啟「拖拉調整」後往右拖 2 天
  await page.getByRole('button', { name: '拖拉調整' }).click();
  await bar.scrollIntoViewIfNeeded();
  const box = (await bar.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 26, y, { steps: 3 });
  await page.mouse.move(box.x + box.width / 2 + 52, y, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /^E2E 招牌安裝 9\/10 09:00–9\/12 17:30（3 天）/ })).toBeVisible();

  await expect(page.getByText('「E2E 招牌安裝」改為 9/10 09:00–9/12 17:30（3 天）')).toBeVisible();

  // 重新整理後還在：已經存進資料庫
  await page.reload();
  await expect(page.getByRole('button', { name: /^E2E 招牌安裝 9\/10 09:00–9\/12 17:30（3 天）/ })).toBeVisible({ timeout: 60_000 });
});

test('批次輸入單價：一頁打完多個原物料，成本用新的單價', async ({ page }) => {
  await loginAs(page, '示範店長');
  await nav(page, '原物料');
  await page.getByRole('link', { name: '批次輸入單價' }).click();
  await expect(page.getByRole('heading', { name: '批次輸入單價', level: 1 })).toBeVisible();

  // 豬大骨的數量、單位已經帶入預設規格（20 kg），只要打金額
  const bone = page.getByLabel('豬大骨（示範） 金額');
  await bone.fill('1500');
  await expect(page.getByText('→ $75.00/kg')).toBeVisible();
  await bone.press('Enter');
  await expect(bone).not.toBeFocused();

  await page.getByRole('button', { name: '儲存 1 筆' }).click();
  await expect(page.getByText('已儲存 1 筆單價')).toBeVisible();

  await page.getByRole('button', { name: '返回', exact: true }).last().click();
  await page.getByRole('link', { name: /豬大骨（示範）/ }).click();
  await expect(page.getByText('目前單價').locator('..')).toContainText('$75.00/kg');
});

test('刪除原物料：沒用過的可以刪，用過的只能停用', async ({ page }) => {
  await loginAs(page, '示範店長');
  await nav(page, '原物料');
  await page.getByRole('button', { name: '新增' }).click();
  await page.getByRole('dialog').getByLabel('名稱').fill('E2E 打錯的原料');
  await page.getByRole('dialog').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByRole('heading', { name: 'E2E 打錯的原料', level: 1 })).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '刪除' }).click();
  await expect(page.getByText('已刪除「E2E 打錯的原料」')).toBeVisible();
  await expect(page.getByRole('heading', { name: '原物料', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /E2E 打錯的原料/ })).toHaveCount(0);

  // 食譜用過的：沒有刪除按鈕，提示改用停用
  await page.getByRole('link', { name: /豬大骨（示範）/ }).click();
  await page.getByRole('button', { name: '編輯' }).first().click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '刪除' })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByText(/不能刪除；不想再看到可以取消「啟用中」/)).toBeVisible();
});

test('批次輸入單價頁可以直接刪除沒用過的原物料', async ({ page }) => {
  await loginAs(page, '示範店長');
  await nav(page, '原物料');
  await page.getByRole('button', { name: '新增' }).click();
  await page.getByRole('dialog').getByLabel('名稱').fill('E2E 重複的原料');
  await page.getByRole('dialog').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByRole('heading', { name: 'E2E 重複的原料', level: 1 })).toBeVisible();

  await nav(page, '原物料');
  await page.getByRole('link', { name: '批次輸入單價' }).click();
  // 食譜用過的沒有刪除按鈕
  await expect(page.getByRole('button', { name: '刪除 豬大骨（示範）' })).toHaveCount(0);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '刪除 E2E 重複的原料' }).click();
  await expect(page.getByText('已刪除「E2E 重複的原料」')).toBeVisible();
  await expect(page.getByLabel('E2E 重複的原料 金額')).toHaveCount(0);
});

test('食譜用料可以直接點進去更新單價', async ({ page }) => {
  await loginAs(page, '示範店長');
  await openVersion(page, '招牌湯麵（示範）', 1);
  const line = page.getByRole('button', { name: /^生麵條（示範）.*更新單價/ });
  await line.click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: '單價：生麵條（示範）' })).toBeVisible();
  await sheet.getByLabel('金額').fill('999');
  const preview = (await sheet.getByText(/^新的單價 /).textContent())!.replace('新的單價 ', '');
  await sheet.getByRole('button', { name: '儲存單價' }).click();
  await expect(page.getByText('已更新「生麵條（示範）」的單價')).toBeVisible();

  await line.click();
  await expect(page.getByRole('dialog').getByText('目前單價').locator('..')).toContainText(preview);
});
