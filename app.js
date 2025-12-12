require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const { Client } = require("@notionhq/client");

const app = express();

const userSessions = {};

const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✨ 初始化 Notion Client
const notion = new Client({ auth: process.env.NOTION_API_KEY });

app.post("/webhook", line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

async function handleEvent(event) {
    const userId = event.source.userId;
    const replyToken = event.replyToken;
    const targetId =
        event.source.groupId || event.source.roomId || event.source.userId;

    // -----------------------------------------------------------
    // 🔔 第一關：監聽「啟動指令」
    // -----------------------------------------------------------
    if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text.trim();
        if (["分析熱量", "開始記錄"].includes(text)) {
            // 稍微放寬指令
            userSessions[userId] = { images: [], texts: [] };
            setTimeout(() => {
                if (userSessions[userId]) delete userSessions[userId];
            }, 5 * 60 * 1000);
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "喵喵！開始記錄！\n請傳送食物照片或文字說明。\n中途想取消記錄請輸入「取消」喵",
            });
        }
    }

    // 🔒 門神檢查
    if (!userSessions[userId]) return Promise.resolve(null);

    const session = userSessions[userId];

    // -----------------------------------------------------------
    // 🖼️ 情況 A：收到「圖片」
    // -----------------------------------------------------------
    if (event.type === "message" && event.message.type === "image") {
        try {
            const stream = await lineClient.getMessageContent(event.message.id);
            const imageBuffer = await streamToBuffer(stream);
            session.images.push(imageBuffer.toString("base64")); // 存 base64

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

    // -----------------------------------------------------------
    // 🗣️ 情況 B：收到「文字」
    // -----------------------------------------------------------
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

            await lineClient.replyMessage(replyToken, {
                type: "text",
                text: "喵喵收到！計算中並寫入 Notion...",
            });

            try {
                // 1. AI 分析
                const foodData = await analyzeSessionData(
                    session.images,
                    session.texts
                );

                // 2. ✨ 取得使用者暱稱 (Display Name)
                let userName = "未知使用者";
                try {
                    // 如果是在群組，要用 getGroupMemberProfile，個人則用 getProfile
                    // 為了簡化，我們先嘗試直接抓 User Profile
                    const profile = await lineClient.getProfile(userId);
                    userName = profile.displayName;
                } catch (e) {
                    console.log("無法取得暱稱，可能未加好友:", e.message);
                }

                // 3. ✨ 寫入 Notion
                await saveToNotion(foodData, userName);

                const replyText = `🍽️ 分析完成並已存檔！\n\n👤 紀錄者：${userName}\n🍱 名稱：${foodData.food_name}\n🔥 熱量：${foodData.calories} kcal\n💪 蛋白質：${foodData.protein}g | 脂肪：${foodData.fat}g | 碳水：${foodData.carbs}g\n\n已寫入資料庫喵！`;

                delete userSessions[userId];
                return lineClient.pushMessage(targetId, {
                    type: "text",
                    text: replyText,
                });
            } catch (error) {
                console.error("處理失敗", error);
                return lineClient.pushMessage(targetId, {
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

    return Promise.resolve(null);
}

// 🧠 AI 分析函式
async function analyzeSessionData(images, texts) {
    let systemContent = `你是一位專業營養師。請依據圖片與文字估算熱量。
    1. 回覆純 JSON: food_name(String), calories(Number), protein(Number), fat(Number), carbs(Number), reasoning(String)。
    2. 若有多張圖，請加總。數值請給數字，不要帶單位。
    3. 請用繁體中文回覆。`;

    if (texts.length > 0) systemContent += `\n補充說明：${texts.join("、")}`;

    const userMessageContent = [{ type: "text", text: systemContent }];
    images.forEach((base64) => {
        userMessageContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64}` },
        });
    });

    const chatCompletion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: userMessageContent }],
        response_format: { type: "json_object" },
    });
    return JSON.parse(chatCompletion.choices[0].message.content);
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
                User: { rich_text: [{ text: { content: userName } }] }, // 記錄是誰吃的
                Note: {
                    rich_text: [{ text: { content: data.reasoning || "" } }],
                },
                Date: { date: { start: new Date().toISOString() } },
            },
        });
        console.log("Notion 寫入成功！");
    } catch (error) {
        console.error("Notion 寫入失敗:", error);
        throw error; // 拋出錯誤讓外面知道
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
