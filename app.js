// =========================================================================
// 引用套件
// =========================================================================
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { Client } = require("@notionhq/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// =========================================================================
// 初始化工具
// =========================================================================
const app = express();

const userSessions = {};

const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// =========================================================================
// 路由設定
// =========================================================================

// 喚醒
app.get("/", (req, res) => {
    res.send("I'm alive! 機器人醒著喵！");
});

// 大掃除
app.get("/cleanup", async (req, res) => {
    try {
        const daysToKeep = 30;
        const dateThreshold = new Date();
        dateThreshold.setDate(dateThreshold.getDate() - daysToKeep);
        const isoDate = dateThreshold.toISOString();

        console.log(`開始執行大掃除！將刪除 ${isoDate} 之前的資料...`);

        // 1. 清理「飲食資料庫」
        await deleteOldRecords(process.env.NOTION_DATABASE_ID, isoDate, "飲食");

        // 2. 清理「運動資料庫」
        if (process.env.NOTION_EXERCISE_DATABASE_ID) {
            await deleteOldRecords(
                process.env.NOTION_EXERCISE_DATABASE_ID,
                isoDate,
                "運動"
            );
        }

        res.send(`大掃除完成！已刪除 ${daysToKeep} 天前的紀錄。`);
    } catch (error) {
        console.error("大掃除失敗:", error);
        res.status(500).send("大掃除發生錯誤");
    }
});

// LINE Webhook（先回應，後處理）
app.post("/webhook", line.middleware(lineConfig), (req, res) => {
    res.status(200).end();
    req.body.events.forEach(async (event) => {
        try {
            await handleEvent(event);
        } catch (err) {
            console.error("事件處理發生錯誤:", err);
        }
    });
});

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`listening on ${port}`);
});

// =========================================================================
// 函式邏輯
// =========================================================================

/**
 * 刪除過期的 Notion 資料
 */
async function deleteOldRecords(databaseId, dateThresholdStr, dbName) {
    let hasMore = true;
    let nextCursor = undefined;
    let deletedCount = 0;

    while (hasMore) {
        const response = await notion.databases.query({
            database_id: databaseId,
            start_cursor: nextCursor,
            filter: {
                property: "Date",
                date: {
                    before: dateThresholdStr,
                },
            },
        });

        for (const page of response.results) {
            await notion.pages.update({
                page_id: page.id,
                archived: true,
            });
            deletedCount++;
        }

        hasMore = response.has_more;
        nextCursor = response.next_cursor;
    }
    console.log(`✅ [${dbName}] 清理完成，共刪除了 ${deletedCount} 筆資料。`);
}

/**
 * 處理 LINE 事件
 */
async function handleEvent(event) {
    const userId = event.source.userId;
    const replyToken = event.replyToken;

    // 監聽「啟動指令」
    if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text.trim();

        if (["分析熱量"].includes(text)) {
            userSessions[userId] = { mode: "food", images: [], texts: [] };
            setTimeout(() => {
                if (userSessions[userId]) delete userSessions[userId];
            }, 5 * 60 * 1000);

            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "喵喵！開始記錄！\n請傳送食物照片或文字說明。\n中途想取消記錄請輸入「取消」喵\n\n⚠️ 注意：輸入計算後，AI 分析需要等待約 5~10 秒，請耐心等候結果，不要重複輸入喔！",
            });
        }

        if (text === "運動記錄" || text === "運動紀錄") {
            userSessions[userId] = { mode: "exercise", content: "" };

            setTimeout(() => {
                if (userSessions[userId]) delete userSessions[userId];
            }, 5 * 60 * 1000);

            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "你好！請輸入運動內容喵！中途想取消記錄請輸入「取消」喵",
            });
        }
    }

    // 門神檢查
    if (!userSessions[userId]) return Promise.resolve(null);

    const session = userSessions[userId];

    // 分流處理：運動模式
    if (
        session.mode === "exercise" &&
        event.type === "message" &&
        event.message.type === "text"
    ) {
        return handleExerciseMode(event, session, userId, replyToken);
    }

    // 分流處理：飲食模式
    if (session.mode === "food") {
        return handleFoodMode(event, session, userId, replyToken);
    }

    return Promise.resolve(null);
}

/**
 * 處理運動模式
 */
async function handleExerciseMode(event, session, userId, replyToken) {
    const text = event.message.text.trim();

    if (["取消", "結束"].includes(text)) {
        delete userSessions[userId];
        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: "已取消運動紀錄。",
        });
    }

    try {
        let userName = "未知使用者";
        try {
            const profile = await lineClient.getProfile(userId);
            userName = profile.displayName;
        } catch (e) {}

        await saveExerciseToNotion(text, userName);

        delete userSessions[userId];

        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: `✅ 運動紀錄完成！\n\n👤 紀錄者：${userName}\n🏃 項目：${text}\n\n繼續保持喵！💪`,
        });
    } catch (error) {
        console.error(error);
        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: "哇哇，分析或存檔失敗了 QQ",
        });
    }
}

/**
 * 處理飲食模式
 */
async function handleFoodMode(event, session, userId, replyToken) {
    // 圖片處理
    if (event.type === "message" && event.message.type === "image") {
        try {
            const stream = await lineClient.getMessageContent(event.message.id);
            const imageBuffer = await streamToBuffer(stream);
            session.images.push(imageBuffer.toString("base64"));

            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: `📸 已收到 ${session.images.length} 張圖片！(目前：${session.images.length} 圖, ${session.texts.length} 文字)\n還有資料請繼續上傳，若完成請輸入「OK」或「計算」喵`,
            });
        } catch (error) {
            console.error("圖片儲存失敗", error);
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "圖片讀取失敗QQ",
            });
        }
    }

    // 文字處理
    if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text.trim();

        if (["分析熱量"].includes(text)) return Promise.resolve(null);

        // 結帳指令
        if (["ok", "OK", "分析", "計算"].includes(text.toLowerCase())) {
            return handleFoodCalculation(session, userId, replyToken);
        }

        // 取消
        if (["取消", "結束"].includes(text)) {
            delete userSessions[userId];
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "取消記錄，我要回去睡覺了喵~",
            });
        }

        session.texts.push(text);
        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: `📝 已記錄文字 (目前：${session.images.length} 圖, ${session.texts.length} 文字)\n還有資料請繼續上傳，若完成請輸入「OK」或「計算」喵`,
        });
    }

    return Promise.resolve(null);
}

/**
 * 處理飲食計算
 */
async function handleFoodCalculation(session, userId, replyToken) {
    if (session.images.length === 0 && session.texts.length === 0) {
        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: "沒資料喵！請先傳照片或文字。",
        });
    }

    try {
        const foodData = await analyzeSessionData(
            session.images,
            session.texts
        );

        let userName = "未知使用者";
        try {
            const profile = await lineClient.getProfile(userId);
            userName = profile.displayName;
        } catch (e) {
            console.log("無法取得暱稱:", e.message);
        }

        await saveToNotion(foodData, userName);

        const replyText = `🍽️ 分析完成並已存檔！\n\n👤 紀錄者：${userName}\n🍱 名稱：${foodData.food_name}\n🔥 熱量：${foodData.calories} kcal\n💪 蛋白質：${foodData.protein}g | 脂肪：${foodData.fat}g | 碳水：${foodData.carbs}g\n\n已寫入資料庫喵！`;

        delete userSessions[userId];

        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: replyText,
        });
    } catch (error) {
        console.error("處理失敗", error);
        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: "哇哇，分析或存檔失敗了 QQ",
        });
    }
}

/**
 * AI 分析食物資料
 */
async function analyzeSessionData(images, texts) {
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: { responseMimeType: "application/json" },
        });

        let promptText = `你是一位講求「客觀寫實」的營養師。請依據圖片與文字估算。
        1. 【份量校正】：請謹慎判斷容器大小。若無比例尺，請預設為「一般一人份量」。勿將液體體積全部算作固體食物熱量。
        2. 【避免高估】：請依據「視覺可見」的內容估算，以「保守、不浮誇」的數值為主。
        3. 【簡化回覆】：reasoning 欄位請限制在「100 字以內」的重點備註。
        4. 回覆純 JSON: food_name(菜名), calories(整份熱量 Number), protein, fat, carbs, reasoning(String)。
        5. 請用繁體中文回覆。`;

        if (texts.length > 0) promptText += `\n補充說明：${texts.join("、")}`;

        const imageParts = images.map((base64) => ({
            inlineData: {
                data: base64,
                mimeType: "image/jpeg",
            },
        }));

        const result = await model.generateContent([promptText, ...imageParts]);
        const response = await result.response;
        let text = response.text();

        text = text
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();

        console.log("Gemini 回傳的原始文字:", text);

        return JSON.parse(text);
    } catch (error) {
        console.error("Gemini 分析失敗:", error);
        throw error;
    }
}

/**
 * 儲存飲食資料到 Notion
 */
async function saveToNotion(data, userName) {
    try {
        await notion.pages.create({
            parent: { database_id: process.env.NOTION_DATABASE_ID },
            properties: {
                Name: {
                    title: [
                        { text: { content: data.food_name || "未知食物" } },
                    ],
                },
                Calories: { number: data.calories || 0 },
                Protein: { number: data.protein || 0 },
                Fat: { number: data.fat || 0 },
                Carbs: { number: data.carbs || 0 },
                User: { rich_text: [{ text: { content: userName } }] },
                Note: {
                    rich_text: [{ text: { content: data.reasoning || "" } }],
                },
                Date: { date: { start: new Date().toISOString() } },
            },
        });
        console.log("Notion 寫入成功！");
    } catch (error) {
        console.error("Notion 寫入失敗:", error);
        throw error;
    }
}

/**
 * 儲存運動資料到 Notion
 */
async function saveExerciseToNotion(content, userName) {
    try {
        const databaseId = process.env.NOTION_EXERCISE_DATABASE_ID;
        if (!databaseId) throw new Error("找不到運動資料庫 ID");

        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                Name: { title: [{ text: { content: content } }] },
                User: { rich_text: [{ text: { content: userName } }] },
                Date: { date: { start: new Date().toISOString() } },
            },
        });
        console.log("運動紀錄寫入成功！");
    } catch (error) {
        console.error("Notion 寫入失敗:", error);
        throw error;
    }
}

/**
 * 將 Stream 轉換為 Buffer
 */
function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
}
