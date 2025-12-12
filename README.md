# 🍱 Smart Diet LINE Bot (AI 飲食紀錄助手)

這是一個結合 **OpenAI GPT-4o** 視覺辨識能力與 **Notion** 資料庫的 LINE 聊天機器人。

它能讓你在 LINE 群組中輕鬆上傳食物照片，自動估算熱量與三大營養素，並將數據即時同步至 Notion，產生個人化的飲食紀錄報表與圖表。

![Project Status](https://img.shields.io/badge/Status-Active-brightgreen) ![License](https://img.shields.io/badge/License-MIT-blue)

## ✨ 功能特色 (Features)

-   **📷 AI 視覺辨識**：使用 GPT-4o 模型，精準辨識照片中的食物種類，自動估算份量與熱量。
-   **🛒 購物車模式 (Batch Upload)**：
    -   支援一次上傳多張照片（例如：便當+飲料+水果）。
    -   可隨時補充文字說明（例如：「飯一半」、「去冰無糖」）。
    -   輸入「OK」或「計算」後，AI 會綜合所有資訊進行總結算。
-   **👥 群組友善設計**：
    -   **喚醒機制**：機器人平時保持安靜，只有輸入 **「開始」**、**「紀錄」** 或 **「點餐」** 時才會啟動，避免干擾群組聊天。
    -   **多人識別**：在群組中使用時，會自動記錄是哪位成員上傳的資料（需設定 LINE Display Name）。
-   **📝 Notion 自動同步**：分析結果自動寫入 Notion Database，欄位包含熱量、蛋白質、脂肪、碳水化合物、使用者暱稱與 AI 分析筆記。
-   **📊 視覺化圖表**：配合 Notion 內建圖表功能，可輕鬆生成多人熱量趨勢圖。

## 🛠️ 技術棧 (Tech Stack)

-   **Runtime**: Node.js
-   **Framework**: Express.js
-   **AI Model**: OpenAI GPT-4o (via OpenAI API)
-   **Messaging**: LINE Messaging API
-   **Database**: Notion API (@notionhq/client)
-   **Tools**: ngrok (本地測試), Render (雲端部署)

## 🚀 快速開始 (Getting Started)

### 1. 前置準備

請確保你擁有以下服務的帳號與 API Keys：

-   **LINE Developers**: 建立 Channel 並取得 `Channel Access Token` 與 `Channel Secret`。
-   **OpenAI**: 註冊並取得 `API Key` (帳號需有 GPT-4o 模型權限)。
-   **Notion**:
    1.  建立一個 Database。
    2.  前往 [Notion Integrations](https://www.notion.so/my-integrations) 建立機器人並取得 `Secret Key`。
    3.  **重要**：在 Database 頁面右上角點選 `...` > `Connect to`，將機器人加入該頁面。

### 2. 安裝專案

```bash
# 1. 下載專案 (若是從 GitHub Clone)
git clone [https://github.com/你的帳號/專案名稱.git](https://github.com/你的帳號/專案名稱.git)

# 2. 進入資料夾
cd 專案名稱

# 3. 安裝必要套件
npm install
```

### 3. 設定環境變數 (.env)

請在專案根目錄建立一個名為 `.env` 的檔案，內容如下：

```env
CHANNEL_ACCESS_TOKEN="你的 LINE Channel Access Token"
CHANNEL_SECRET="你的 LINE Channel Secret"
OPENAI_API_KEY="你的 OpenAI API Key"
NOTION_API_KEY="你的 Notion Integration Secret"
NOTION_DATABASE_ID="你的 Notion Database ID"
PORT=3000
```

### 4. Notion 資料庫欄位設定 (⚠️ 非常重要)

為了讓程式能正確寫入，請務必將 Notion Database 的欄位名稱與屬性設定為以下格式：

| 欄位名稱 (Column Name) | 屬性類型 (Type)     | 說明              |
| :--------------------- | :------------------ | :---------------- |
| **Name**               | `Title` (標題)      | 食物名稱          |
| **Calories**           | **`Number`** (數字) | 熱量 (kcal)       |
| **Protein**            | **`Number`** (數字) | 蛋白質 (g)        |
| **Fat**                | **`Number`** (數字) | 脂肪 (g)          |
| **Carbs**              | **`Number`** (數字) | 碳水化合物 (g)    |
| **User**               | `Rich Text` (文字)  | 記錄使用者暱稱    |
| **Note**               | `Rich Text` (文字)  | AI 分析理由與備註 |
| **Date**               | `Date` (日期)       | 紀錄時間          |

> **注意**：Calories, Protein, Fat, Carbs 必須設為 **Number**，否則寫入會失敗。

### 5. 啟動機器人

**本地開發模式：**

```bash
# 啟動 Node.js 伺服器
node app.js

# 開啟 ngrok (另開終端機視窗)
ngrok http 3000
```

_啟動後，記得將 ngrok 網址 (加上 `/webhook`) 更新至 LINE Developers 後台。_

## 📱 使用指南 (User Guide)

1.  **喚醒機器人**：

    -   在聊天室輸入：**「開始」**、**「紀錄」** 或 **「點餐」**。
    -   機器人回應：🙆‍♂️ 模式啟動！

2.  **上傳資料 (購物車模式)**：

    -   傳送一張或多張食物照片。
    -   傳送文字補充說明（如：「飯一半」、「去皮」）。
    -   機器人會暫存這些資料。

3.  **結算分析**：

    -   輸入：**「OK」** 或 **「計算」**。
    -   機器人開始分析，回傳熱量數據，並自動寫入 Notion。

4.  **取消/重來**：
    -   輸入：**「取消」**、**「結束」** 或 **「重來」** 可清空暫存並關閉模式。

## ☁️ 部署 (Deployment)

本專案已優化，適合部署於 **Render** 免費版。

1.  將程式碼上傳至 GitHub。
2.  在 Render 建立新的 **Web Service**。
3.  設定 Environment Variables (將 `.env` 的內容填入 Render 後台)。
4.  將 Render 提供的網址 (加上 `/webhook`) 更新至 LINE Developers。
5.  _(選用)_ 使用 cron-job.org 每 5 分鐘呼叫一次網址，防止免費版休眠。

## 📄 License

This project is licensed under the MIT License.
