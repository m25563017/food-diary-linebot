require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { Client } = require("@notionhq/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

//喚醒服務
app.get("/", (req, res) => {
    res.send("I'm alive! 機器人醒著喵！");
});

const userSessions = {};

const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// 初始化 Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 初始化 Notion
const notion = new Client({ auth: process.env.NOTION_API_KEY });

// -------------------------------------------------------------------------
// 🚀 關鍵修改區：Webhook 改成「先回應，後處理」
// -------------------------------------------------------------------------
app.post("/webhook", line.middleware(lineConfig), (req, res) => {
    // 收到訊號，馬上回傳 200 OK 給 LINE，避免超時被斷線
    res.status(200).end();
    req.body.events.forEach(async (event) => {
        try {
            await handleEvent(event);
        } catch (err) {
            console.error("事件處理發生錯誤:", err);
        }
    });
});
// -------------------------------------------------------------------------

async function handleEvent(event) {
    const userId = event.source.userId;
    const replyToken = event.replyToken;
    // -----------------------------------------------------------
    // 監聽「啟動指令」
    // -----------------------------------------------------------
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

    // -----------------------------------------------------------
    // 分流處理：如果是「運動模式」
    // -----------------------------------------------------------
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

    // -----------------------------------------------------------
    // 分流處理：如果是「飲食模式」
    // -----------------------------------------------------------
    if (session.mode === "food") {
        // 圖片處理
        if (event.type === "message" && event.message.type === "image") {
            try {
                const stream = await lineClient.getMessageContent(
                    event.message.id
                );
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

            // --- 結帳指令 ---
            if (["ok", "OK", "分析", "計算"].includes(text.toLowerCase())) {
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

            // --- 取消 ---
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
    }

    return Promise.resolve(null);
}

// AI 分析
async function analyzeSessionData(images, texts) {
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash-latest",
            // 強制回應 JSON 格式
            generationConfig: { responseMimeType: "application/json" },
        });

        let promptText = `你是一位專業健身營養師。請依據圖片視覺估算食物份量與熱量。
        1. 必須嚴格分析：請仔細辨識盤子大小、食物堆疊高度來估算公克數。
        2. 隱藏熱量警示：請考慮烹調用油、醬汁(如沙拉醬、肉燥)的熱量。
        3. 回覆純 JSON: food_name(總結菜名), calories(總熱量), protein, fat, carbs, reasoning(詳細的分析理由，包含估算的公克數)。
        4. 請用繁體中文。`;

        if (texts.length > 0) promptText += `\n補充說明：${texts.join("、")}`;

        // 準備圖片資料 (Gemini 格式)
        const imageParts = images.map((base64) => ({
            inlineData: {
                data: base64,
                mimeType: "image/jpeg",
            },
        }));

        // 發送請求
        const result = await model.generateContent([promptText, ...imageParts]);
        const response = await result.response;
        const text = response.text();

        return JSON.parse(text);
    } catch (error) {
        console.error("Gemini 分析失敗:", error);
        throw error;
    }
}

// Notion 存檔函式
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

// 運動存檔函式
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
