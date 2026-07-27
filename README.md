# Smart Diet & Exercise LINE Bot (AI 健康紀錄助手)

這是一個結合 Google Gemini (AI 視覺辨識) 與 Notion 資料庫的 LINE 聊天機器人。

本專案旨在打造全方位的個人健康儀表板，不僅能透過 AI 自動估算食物照片的熱量與營養素，還能快速記錄運動內容。系統會將「飲食」與「運動」數據分別同步至兩個獨立的 Notion 資料庫，並具備自動清理過期資料的功能，以保持資料庫輕量化。

## 功能特色

### AI 飲食辨識

-   採用 **Google Gemini（預設模型 gemini-3.5-flash）**，具備強大的視覺辨識能力，若遇服務忙碌（503 錯誤）會自動切換至 gemini-3-flash-preview 備援模型重試，提升回應穩定度。
-   支援 **購物車模式**：使用者可連續傳送多張食物照片或文字補充說明，最後輸入指令一次進行總結算。
-   若單次上傳包含多項食物，系統會自動將 AI 回傳的多筆結果合併計算總熱量與總營養素，並整合為單一筆紀錄。
-   自動分析項目包含：食物名稱、卡路里 (kcal)、蛋白質、脂肪、碳水化合物，以及簡短的營養分析備註。
-   內建 JSON 解析容錯機制：當 AI 回傳格式異常（如夾帶額外文字或未跳脫的引號）時，會自動修復或重新請求一次，避免因格式問題導致分析失敗。

### 運動紀錄

-   提供快速記錄模式，輸入文字即可存檔（例如：慢跑 30 分鐘、深蹲 50 下）。
-   同樣採用 Gemini AI 依據使用者體態資訊估算運動消耗熱量，並具備與飲食辨識相同的備援模型切換與 JSON 解析容錯機制。
-   系統會自動將資料分流至專屬的「運動紀錄」資料庫，避免與飲食數據混淆。

### 補登日期

-   飲食與運動紀錄皆支援於文字說明中補上日期，系統會自動辨識並將紀錄寫入指定日期，而非預設的當下時間。
-   支援格式：`YYYY/MM/DD`、`YYYY-MM-DD`、`MM/DD`、`MM-DD`（例如：「12/25 聚餐吃了火鍋」），未指定年份時以當年度計算。

### 自動資料維護 (每日大掃除)

-   **自動清理機制**：內建資料庫維護功能，預設保留 60 天內的資料，逾期資料將被封存。如需調整保留天數，需修改程式碼中 `daysToKeep` 的設定值。
-   **Notion API v5 架構**：支援最新的 Notion 多重資料來源 (Data Sources) 架構，能自動轉換 ID 並執行搜尋與封存 (Archive) 動作，確保過期資料不會佔用版面。

### 群組友善設計

-   **喚醒機制**：機器人平時處於待機狀態，需輸入特定指令（如「開始記錄」、「運動紀錄」）才會啟動，避免干擾群組日常對話。
-   **自動署名**：在群組使用時，系統會自動抓取 LINE 使用者暱稱並記錄於資料庫中，適合家庭或好友共同使用。

### 雲端部署與成本優化

-   **省錢模式**：利用 LINE Messaging API 的 Reply Token 機制，大幅減少主動推播 (Push Message) 的費用。
-   **防止休眠**：內建喚醒路徑 (Keep-alive endpoint)，搭配 Cron-job 服務可確保部署在 Render 等免費平台上的服務 24 小時運作。

## 技術架構

-   **執行環境**: Node.js
-   **框架**: Express.js
-   **AI 模型**: Google Gemini (透過 Google Generative AI SDK)，預設使用 gemini-3.5-flash，於服務忙碌時自動切換至 gemini-3-flash-preview 備援模型
-   **通訊介面**: LINE Messaging API (@line/bot-sdk)
-   **資料庫**: Notion API (@notionhq/client v5.x)
-   **工具**: ngrok (本地開發測試), Render (雲端部署), Cron-job.org (排程喚醒與大掃除)

## 快速開始

### 1. 前置準備

請確保你擁有以下服務的帳號與 API 金鑰：

-   **LINE Developers**: 取得 Channel Access Token 與 Channel Secret。
-   **Google AI Studio**: 申請一組 API Key (需開通 Gemini API 權限)。
-   **Notion**:
    1. 前往 Notion Integrations 建立機器人並取得 Secret Key。
    2. 建立兩個資料庫 (Database)：一個用於儲存飲食，一個用於儲存運動。
    3. **授權機器人**：務必在兩個資料庫頁面的右上角點選選單 > `Connect to`，將你的機器人加入連線。

### 2. 安裝與設定專案

請依序在終端機 (Terminal) 執行以下指令：

```bash
# 1. 下載專案程式碼
git clone [https://github.com/你的帳號/專案名稱.git](https://github.com/你的帳號/專案名稱.git)

# 2. 進入專案資料夾
cd 專案名稱

# 3. 安裝必要套件
npm install
```

### 3. 設定環境變數 (.env)

請在專案根目錄建立一個名為 .env 的檔案，並填入以下資訊（請將等號後面的文字替換為你的真實金鑰）：

```bash
CHANNEL_ACCESS_TOKEN="你的 LINE Channel Access Token"
CHANNEL_SECRET="你的 LINE Channel Secret"
GEMINI_API_KEY="你的 Google Gemini API Key"
NOTION_API_KEY="你的 Notion Integration Secret"
NOTION_DATABASE_ID="飲食資料庫的 ID (從網址列取得)"
NOTION_EXERCISE_DATABASE_ID="運動資料庫的 ID (從網址列取得)"
PORT=3000
```

### 4. Notion 資料庫欄位設定

為了讓程式能正確寫入資料，請務必依照以下格式設定 Notion 資料庫的欄位名稱與屬性 (Property Type)：

**資料庫 A：飲食日記 (Diet DB)**

| 欄位名稱 (Name) | 屬性 (Type)      | 說明           |
| :-------------- | :--------------- | :------------- |
| **Name**        | Title (標題)     | 食物名稱       |
| **Calories**    | Number (數字)    | 熱量 (kcal)    |
| **Protein**     | Number (數字)    | 蛋白質 (g)     |
| **Fat**         | Number (數字)    | 脂肪 (g)       |
| **Carbs**       | Number (數字)    | 碳水化合物 (g) |
| **User**        | Rich Text (文字) | 使用者暱稱     |
| **Note**        | Rich Text (文字) | AI 分析筆記    |
| **Date**        | Date (日期)      | 紀錄時間       |

**資料庫 B：運動日記 (Exercise DB)**

| 欄位名稱 (Name) | 屬性 (Type)      | 說明        |
| :-------------- | :--------------- | :---------- |
| **Name**        | Title (標題)     | 運動項目    |
| **Calories**    | Number (數字)    | 消耗熱量 (kcal) |
| **User**        | Rich Text (文字) | 使用者暱稱  |
| **Note**        | Rich Text (文字) | AI 分析筆記 |
| **Date**        | Date (日期)      | 紀錄時間    |

### 5. 部署與設定排程

**雲端部署 (Render)**

1. 將程式碼推送到 GitHub。
2. 在 Render 建立新的 Web Service。
3. 在 Render 的 Environment 頁面設定上述的環境變數。
4. **重要**：由於使用了 Notion SDK v5，若更新程式碼，建議點選 `Manual Deploy` > `Clear build cache & deploy` 以確保套件版本正確安裝。

**設定自動排程 (Cron-job)**
前往 Cron-job.org 設定兩個排程：

1. **喚醒服務**：每 5-10 分鐘呼叫一次 `https://你的網址/` (防止伺服器休眠)。
2. **每日大掃除**：每天固定時間 (如凌晨 4 點) 呼叫一次 `https://你的網址/cleanup` (自動封存 60 天前的舊資料)。

## 使用指南

### 模式一：飲食紀錄

1. 在聊天室輸入 **「開始記錄」** 或 **「分析熱量」**。
2. 傳送食物照片（支援多張）或輸入文字補充說明，如需補登日期，可在文字中加上日期（例如：「12/25 聚餐」）。
3. 上傳完畢後，輸入 **「OK」**、**「計算」** 或 **「分析」** 進行結算。
4. 等待約 5-10 秒，機器人將回傳 AI 分析結果並自動寫入 Notion。

### 模式二：運動紀錄

1. 在聊天室輸入 **「運動紀錄」** (或運動記錄)。
2. 直接輸入運動內容，可分次輸入多筆（例如：深蹲 50 下、慢跑 3 公里），同樣支援於文字中補上日期。
3. 輸入 **「OK」**、**「計算」** 或 **「分析」** 進行結算，機器人確認後即自動存檔。

### 通用指令

-   輸入 **「取消」** 或 **「結束」**：立即停止目前的紀錄模式。
-   **防呆機制**：若使用者開啟模式後 5 分鐘內無動作，機器人將自動結束該次工作階段。
-   **忙碌提示**：若 AI 服務暫時無法回應，機器人會提示稍後再試，並自動結束當次工作階段，需重新輸入指令開始記錄。

## 授權條款

本專案採用 MIT License 授權。
