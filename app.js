require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { Client } = require("@notionhq/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// ==========================================
// 1. 初始化區
// ==========================================

const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// 初始化 Notion
const notion = new Client({ auth: process.env.NOTION_API_KEY });

// 初始化 Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const userSessions = {};

// ==========================================
// 2. 路由設定區
// ==========================================

// 喚醒機器人
app.get("/", (req, res) => {
    res.send("I'm alive! 機器人醒著喵！");
});

// 每日大掃除
app.get("/cleanup", async (req, res) => {
    try {
        const daysToKeep = 30; // 設定保留天數
        const dateThreshold = new Date();
        dateThreshold.setDate(dateThreshold.getDate() - daysToKeep);
        const isoDate = dateThreshold.toISOString();

        console.log(`🧹 開始執行大掃除！將刪除 ${isoDate} 之前的資料...`);

        await deleteOldRecords(process.env.NOTION_DATABASE_ID, isoDate, "飲食");

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
        res.status(500).send("大掃除發生錯誤: " + error.message);
    }
});

// LINE Webhook
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

// ==========================================
// 3. 核心函式區
// ==========================================

/**
 * 刪除過期資料
 */
async function deleteOldRecords(databaseId, dateThresholdStr, dbName) {
    let hasMore = true;
    let nextCursor = undefined;
    let deletedCount = 0;

    // ID 轉換：Database ID -> Data Source ID
    let dataSourceId = databaseId;
    try {
        console.log(`[${dbName}] 正在轉換 ID...`);
        const dbInfo = await notion.databases.retrieve({
            database_id: databaseId,
        });

        if (dbInfo.data_sources && dbInfo.data_sources.length > 0) {
            dataSourceId = dbInfo.data_sources[0].id;
            console.log(
                `✅ [${dbName}] ID 轉換成功！使用 Data Source ID: ${dataSourceId}`
            );
        } else {
            console.log(
                `⚠️ [${dbName}] 找不到 data_sources，嘗試使用原 ID (可能失敗)...`
            );
        }
    } catch (e) {
        console.error(`❌ [${dbName}] ID 轉換失敗:`, e.message);
    }

    console.log(`[${dbName}] 正在搜尋 ${dateThresholdStr} 之前的資料...`);

    while (hasMore) {
        try {
            const response = await notion.dataSources.query({
                data_source_id: dataSourceId,
                start_cursor: nextCursor,
                filter: {
                    property: "Date",
                    date: { before: dateThresholdStr },
                },
            });

            for (const page of response.results) {
                await notion.pages.update({
                    page_id: page.id,
                    archived: true, // 刪除
                });
                deletedCount++;
            }

            hasMore = response.has_more;
            nextCursor = response.next_cursor;
        } catch (error) {
            console.error(`❌ [${dbName}] 搜尋/刪除中斷:`, error.message);
            break;
        }
    }
    console.log(`✅ [${dbName}] 清理完成，共刪除了 ${deletedCount} 筆資料。`);
}

/**
 * 事件分流
 */
async function handleEvent(event) {
    const userId = event.source.userId;
    const replyToken = event.replyToken;

    if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text.trim();

        if (["分析熱量", "開始記錄"].includes(text)) {
            userSessions[userId] = { mode: "food", images: [], texts: [] };
            setTimeout(() => {
                if (userSessions[userId]) delete userSessions[userId];
            }, 5 * 60 * 1000);
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "喵喵！開始記錄！\n請傳送食物照片或文字說明。\n結束請輸入「Ok」或「計算」喵",
            });
        }

        if (text === "運動記錄" || text === "運動紀錄") {
            userSessions[userId] = { mode: "exercise", content: "" };
            setTimeout(() => {
                if (userSessions[userId]) delete userSessions[userId];
            }, 5 * 60 * 1000);
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "請輸入運動內容喵！",
            });
        }
    }

    if (!userSessions[userId]) return Promise.resolve(null);
    const session = userSessions[userId];

    // 運動模式
    if (
        session.mode === "exercise" &&
        event.type === "message" &&
        event.message.type === "text"
    ) {
        const text = event.message.text.trim();
        if (["取消", "結束"].includes(text)) {
            delete userSessions[userId];
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "已取消。",
            });
        }

        let userName = "未知使用者";
        try {
            const profile = await lineClient.getProfile(userId);
            userName = profile.displayName;
        } catch (e) {}

        await saveExerciseToNotion(text, userName);
        delete userSessions[userId];
        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: `✅ 運動紀錄完成！(${userName})`,
        });
    }

    // 飲食模式
    if (session.mode === "food") {
        if (event.type === "message" && event.message.type === "image") {
            const stream = await lineClient.getMessageContent(event.message.id);
            const imageBuffer = await streamToBuffer(stream);
            session.images.push(imageBuffer.toString("base64"));
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: `📸 收到了！目前 ${session.images.length} 張圖與 ${session.texts.length} 筆文字。`,
            });
        }

        if (event.type === "message" && event.message.type === "text") {
            const text = event.message.text.trim();
            if (["分析熱量"].includes(text)) return Promise.resolve(null);

            if (["ok", "OK", "分析", "計算"].includes(text.toLowerCase())) {
                if (session.images.length === 0 && session.texts.length === 0)
                    return lineClient.replyMessage(replyToken, {
                        type: "text",
                        text: "沒資料喵！",
                    });

                try {
                    const foodData = await analyzeSessionData(
                        session.images,
                        session.texts
                    );
                    let userName = "未知使用者";
                    try {
                        const profile = await lineClient.getProfile(userId);
                        userName = profile.displayName;
                    } catch (e) {}

                    await saveToNotion(foodData, userName);
                    delete userSessions[userId];
                    const cals = foodData.calories || 0;
                    return lineClient.replyMessage(replyToken, {
                        type: "text",
                        text: `🍽️ 分析完成！\n👤 ${userName}\n🍱 ${
                            foodData.food_name
                        }\n🔥 ${cals} kcal\n🥚 蛋白質：${
                            foodData.protein || 0
                        }g\n🥔 碳水：${foodData.carbs || 0}g\n🥓 脂肪：${
                            foodData.fat || 0
                        }g\n\n已寫入資料庫喵！`,
                    });
                } catch (error) {
                    return lineClient.replyMessage(replyToken, {
                        type: "text",
                        text: "分析失敗了 QQ",
                    });
                }
            }

            if (["取消", "結束"].includes(text)) {
                delete userSessions[userId];
                return lineClient.replyMessage(replyToken, {
                    type: "text",
                    text: "已取消。",
                });
            }

            session.texts.push(text);
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "📝 文字已記錄！\n目前 ${session.images.length} 張圖與 ${session.texts.length} 筆文字。",
            });
        }
    }
    return Promise.resolve(null);
}

/**
 * Gemini 分析
 */
async function analyzeSessionData(images, texts) {
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: { responseMimeType: "application/json" },
        });

        let promptText = `你是一位講求「客觀寫實」的營養師。
        1. 份量校正：若無比例尺，預設為「一般一人份量」。
        2. 避免高估：以「視覺可見」為主，保守估算。
        3. 回覆純 JSON: food_name(String), calories(Number), protein(Number), fat(Number), carbs(Number), reasoning(String, 限100字)。
        4. 請用繁體中文。`;

        if (texts.length > 0) promptText += `\n補充說明：${texts.join("、")}`;

        const imageParts = images.map((base64) => ({
            inlineData: { data: base64, mimeType: "image/jpeg" },
        }));
        const result = await model.generateContent([promptText, ...imageParts]);
        const text = result.response
            .text()
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();

        console.log("AI 回傳的原始內容:", text);

        let data = JSON.parse(text);

        // 如果 AI 回傳的是陣列
        if (Array.isArray(data)) {
            console.log("💡 偵測到多項食物，開始合併計算...");

            // 把陣列變回單一物件
            const combinedData = {
                food_name: data.map((item) => item.food_name).join(" + "),
                calories: data.reduce(
                    (sum, item) => sum + (item.calories || 0),
                    0
                ),
                protein: data.reduce(
                    (sum, item) => sum + (item.protein || 0),
                    0
                ),
                fat: data.reduce((sum, item) => sum + (item.fat || 0), 0),
                carbs: data.reduce((sum, item) => sum + (item.carbs || 0), 0),
                reasoning: data.map((item) => item.reasoning).join("\n"),
            };
            data = combinedData;
        }

        if (!data.food_name && data.name) data.food_name = data.name;

        return data;
    } catch (error) {
        console.error("Gemini Error:", error);
        return {
            food_name: "分析失敗",
            calories: 0,
            reasoning: "哇哇，分析失敗了 QQ",
        };
    }
}

// 存檔工具
async function saveToNotion(data, userName) {
    await notion.pages.create({
        parent: { database_id: process.env.NOTION_DATABASE_ID },
        properties: {
            Name: {
                title: [{ text: { content: data.food_name || "未知食物" } }],
            },
            Calories: { number: data.calories || 0 },
            Protein: { number: data.protein || 0 },
            Fat: { number: data.fat || 0 },
            Carbs: { number: data.carbs || 0 },
            User: { rich_text: [{ text: { content: userName } }] },
            Note: { rich_text: [{ text: { content: data.reasoning || "" } }] },
            Date: { date: { start: new Date().toISOString() } },
        },
    });
}

async function saveExerciseToNotion(content, userName) {
    await notion.pages.create({
        parent: { database_id: process.env.NOTION_EXERCISE_DATABASE_ID },
        properties: {
            Name: { title: [{ text: { content: content } }] },
            User: { rich_text: [{ text: { content: userName } }] },
            Date: { date: { start: new Date().toISOString() } },
        },
    });
}

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`listening on ${port}`);
});
