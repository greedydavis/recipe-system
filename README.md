# 試菜與標準食譜系統

麵店籌備團隊的內部網站，介面為繁體中文，以手機操作為主。用途包括：

- 管理菜品與元件（湯底、醬料、配料）
- 控制食譜版本，並記錄試菜評分
- 自動計算成本與食材毛利
- 印出內場可以直接使用的標準卡

- 規格：[docs/SPEC.md](docs/SPEC.md)
- 開發規則：[CLAUDE.md](CLAUDE.md)

## 本機試用（示範模式）

```bash
npm install
npm run dev
```

打開 http://localhost:5188 。沒有設定 Supabase 時會自動進入**示範模式**：整個資料庫在瀏覽器內執行（PGlite），資料只存在這台電腦的瀏覽器。登入頁可以直接選「示範創辦人／主廚／店長／試吃員」切換角色。

### 匯入基準版菜單

```bash
npm run seed:baseline
```

這個指令讀取上一層資料夾的《餐廳菜單_完整試作與配方表.xlsx》，產生 `private/baseline-seed.json`。`private/` 不會進 git。接著用創辦人身分，到「更多 → 資料匯出與匯入」按「從 private/baseline-seed.json 匯入」即可。上線後的正式環境，改用「選擇 JSON 檔」上傳同一個檔案。

匯入規則：

- 湯底會建成元件並送「試菜中」，菜品才能引用
- 菜品建成 v1 草案；基準版沒寫克重的用料會顯示「用量待填」
- 自製半成品（各種醬汁、香油、配料）先建成原物料，備註會提醒之後改成元件
- 資料疑點會寫進版本備註，例如兩張工作表的麵量不一致、菜名提到的食材沒有出現在用料裡

## 測試

```bash
npm run typecheck
npm test
```

`npm test` 包含：

- 計算核心：單位換算、損耗、巢狀元件、毛利、份量換算，以及黃金範例
- 資料庫測試：在 PGlite 上跑同一套 migrations，涵蓋角色權限、版本凍結、狀態轉移、試菜評分、操作紀錄

不需要 Docker。

## 上線步驟

網站網址：https://greedydavis.github.io/recipe-system/ 。推送到 `main` 後，GitHub Actions 會先跑測試。Supabase 設定好之後才會自動部署；在那之前只跑測試，不會把示範模式放上正式網址。

### 1. 建立 Supabase 專案

1. 到 [supabase.com](https://supabase.com) 用訓練紀錄同一個帳號，New Project 建立新專案。免費方案可以有 2 個專案。
   - Region 選離台灣近的，例如 Northeast Asia（Tokyo）
   - 保持 **Enable Data API** 開啟，系統靠它呼叫資料庫 RPC
2. 在本機執行 `npm run db:bundle`，產生 `supabase/setup-all.sql`。
3. Supabase 左側 **SQL Editor** → New query → 貼上 `setup-all.sql` 全部內容 → Run。
   - 會建立所有資料表、RPC、權限、照片 bucket 與存取規則
   - 最後一列出現「安裝完成」代表成功（`rpc_count` 50、`table_count` 20、`photo_bucket` 1）
   - 整份檔案是一個交易：中途出錯會全部復原，修正後可以重新執行；已經裝好的專案再執行會被擋下
4. **Project Settings → API Keys**：複製 Project URL 與 **Publishable key**。舊專案顯示的是 anon public key，兩者都可以用。
5. **Authentication → Sign In / Providers → Email**：保持開啟。
   - 建議**關閉 Confirm email**：Supabase 內建寄信每小時只能寄少量信，團隊一起註冊很容易卡住
   - 新帳號本來就要由創辦人指派角色才能使用，所以關閉驗證信不會讓外人看到資料

### 2. 先建立創辦人帳號（部署之前）

**第一個註冊的帳號會自動成為創辦人。** 網站公開之後任何人都能打開註冊頁，所以要在部署前先建立創辦人帳號：

1. Supabase 後台 **Authentication → Users → Add user → Create new user**
2. 填創辦人的 Email 與密碼，勾選 **Auto Confirm User**

之後其他人自己註冊的帳號都是「待審核」，看不到任何資料，由創辦人到「更多 → 帳號與角色」指派角色。

### 3. 設定 GitHub 變數，觸發部署

GitHub repo → **Settings → Secrets and variables → Actions → Variables** → 新增兩個 repository variables：

| 名稱 | 值 |
|---|---|
| `VITE_SUPABASE_URL` | Project URL，例如 `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Publishable key（或舊的 anon key） |

設定完到 **Actions → 測試並部署到 GitHub Pages → Run workflow** 手動跑一次，或推送新的 commit。

這把金鑰本來就是公開給前端使用的，資料安全由資料庫權限負責。**Secret key（舊名 service role key）絕對不要放進 GitHub、前端或 repo。**

本機要連正式資料庫時，改用 `.env.local`（不會進 git），填同樣兩個變數。

### 4. 上線後檢查

1. 用創辦人帳號登入，確認首頁正常
2. 「更多 → 資料匯出與匯入 → 選擇 JSON 檔」，上傳本機的 `private/baseline-seed.json`，匯入基準版菜單
3. 用手機開啟網站，上傳一張試做照片，確認照片可以看到
4. 請其他成員註冊，由創辦人指派角色

## 備份

Supabase 免費方案沒有可下載的自動備份。請創辦人每週到「更多 → 資料匯出與匯入 → 下載全部資料」，並把檔案存在安全的地方。

另外，免費專案連續 7 天沒有使用會被暫停，進入 Supabase 後台按 Restore 就能恢復。
