# 🍱 Smart Diet & Exercise LINE Bot (AI 健康紀錄助手)

這是一個結合 **OpenAI GPT-4o** 視覺辨識能力與 **Notion** 資料庫的 LINE 聊天機器人。

它不僅能自動估算食物熱量，還能記錄運動內容，並將「飲食」與「運動」數據分別同步至兩個不同的 Notion 資料庫，打造全方位的個人健康儀表板。

![Project Status](https://img.shields.io/badge/Status-Active-brightgreen) ![License](https://img.shields.io/badge/License-MIT-blue)

## ✨ 功能特色 (Features)

-   **📷 AI 飲食辨識**：
    -   傳送食物照片，AI 自動分析熱量與營養素 (卡路里、蛋白質、脂肪、碳水)。
    -   支援 **購物車模式**：可一次傳多張照片與補充文字，最後再一次結算。
-   **🏋️‍♀️ 運動日記**：
    -   輸入文字即可快速記錄運動內容 (如：慢跑 30 分鐘)。
    -   自動分流至專屬的「運動紀錄」資料庫，保持版面整潔。
-   **👥 群組友善與多人識別**：
    -   **喚醒機制**：輸入特定指令（如「開始記錄」、「運動紀錄」）才會啟動，不干擾日常聊天。
    -   **自動署名**：自動抓取 LINE 暱稱，適合家庭或好友群組共用，清楚知道是誰記的。
-   **💰 省錢模式 (Free Tier Friendly)**：
    -   優化訊息回應邏輯，大幅減少 LINE 官方帳號的主動推播 (Push Message) 消耗，適合免費版帳號使用。
-   **☁️ 24/7 不休眠**：
    -   內建喚醒機制 (Keep-alive endpoint)，搭配 Cron-job 可防止雲端伺服器休眠。

## 🛠️ 技術棧 (Tech Stack)

-   **Runtime**: Node.js
-   **Framework**: Express.js
-   **AI Model**: OpenAI GPT-4o (via OpenAI API)
-   **Messaging**: LINE Messaging API
-   **Database**: Notion API (@notionhq/client)
-   **Tools**: ngrok (本地測試), Render (雲端部署), Cron-job.org (喚醒服務)

## 🚀 快速開始 (Getting Started)

### 1. 前置準備

請確保你擁有以下服務的帳號與 API Keys：

-   **LINE Developers**: 取得 `Channel Access Token` 與 `Channel Secret`。
-   **OpenAI**: 取得 `API Key` (需有 GPT-4o 權限)。
-   **Notion**:
    1.  前往 [Notion Integrations](https://www.notion.so/my-integrations) 建立機器人並取得 `Secret Key`。
    2.  **建立兩個 Database** (一個存飲食、一個存運動)。
    3.  **授權機器人**：在**兩個**資料庫頁面的右上角點選 `...` > `Connect to`，將機器人加入。

### 2. 安裝專案

```bash
# 1. 下載專案
git clone https://github.com/你的帳號/專案名稱.git

# 2. 進入資料夾
cd 專案名稱

# 3. 安裝必要套件
npm install
```

### 3. 設定環境變數 (.env)

請在專案根目錄建立 `.env` 檔案，並填入以下資訊：

```env
CHANNEL_ACCESS_TOKEN="你的 LINE Channel Access Token"
CHANNEL_SECRET="你的 LINE Channel Secret"
OPENAI_API_KEY="你的 OpenAI API Key"
NOTION_API_KEY="你的 Notion Integration Secret"
NOTION_DATABASE_ID="飲食資料庫的 ID"
NOTION_EXERCISE_DATABASE_ID="運動資料庫的 ID"
PORT=3000
```

### 4. Notion 資料庫欄位設定 (⚠️ 重要)

為了讓程式能正確寫入，請務必依照以下格式設定欄位名稱與屬性：

#### 🥗 資料庫 A：飲食日記 (Diet DB)

| 欄位名稱 (Name) | 屬性 (Type)  | 說明           |
| :-------------- | :----------- | :------------- |
| **Name**        | `Title`      | 食物名稱       |
| **Calories**    | **`Number`** | 熱量 (kcal)    |
| **Protein**     | **`Number`** | 蛋白質 (g)     |
| **Fat**         | **`Number`** | 脂肪 (g)       |
| **Carbs**       | **`Number`** | 碳水化合物 (g) |
| **User**        | `Rich Text`  | 使用者暱稱     |
| **Note**        | `Rich Text`  | AI 分析筆記    |
| **Date**        | `Date`       | 紀錄時間       |

#### 🏃 資料庫 B：運動日記 (Exercise DB)

| 欄位名稱 (Name) | 屬性 (Type) | 說明       |
| :-------------- | :---------- | :--------- |
| **Name**        | `Title`     | 運動內容   |
| **User**        | `Rich Text` | 使用者暱稱 |
| **Date**        | `Date`      | 紀錄時間   |

### 5. 啟動機器人

**本地開發：**

```bash
node app.js
# 另開視窗執行 ngrok http 3000
```

**雲端部署 (Render)：**
本專案已包含 `app.get('/')` 喚醒路由，部署後可配合 [cron-job.org](https://cron-job.org/) 設定每 5 分鐘訪問一次首頁，防止伺服器休眠。

## 📱 使用指南 (User Guide)

### 🥗 模式一：飲食紀錄

1.  輸入 **「開始記錄」** 或 **「分析熱量」**。
2.  傳送食物照片（可多張）或文字補充。
3.  傳完後輸入 **「計算」** 或 **「OK」**。
4.  等待約 5-10 秒，機器人回傳分析結果並存檔。

### 🏃 模式二：運動紀錄

1.  輸入 **「運動紀錄」** (或運動記錄)。
2.  直接輸入運動內容（例如：深蹲 50 下、慢跑 3km）。
3.  機器人確認後即自動存檔。

### ❌ 通用指令

-   輸入 **「取消」** 或 **「結束」**：立即停止目前的紀錄模式。
-   **防呆機制**：若 5 分鐘內無動作，機器人會自動結束模式。

## 📄 License

This project is licensed under the MIT License.
