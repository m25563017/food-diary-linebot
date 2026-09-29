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

// 依序嘗試的模型：前一個 503 或網路失敗時換下一個
const GEMINI_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
];

const defaultUserStats = "女性，身高 160 公分，體重 60 公斤";

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
        const daysToKeep = 60; // 設定保留天數
        const dateThreshold = new Date();
        dateThreshold.setDate(dateThreshold.getDate() - daysToKeep);
        const isoDate = dateThreshold.toISOString();

        console.log(`🧹 開始執行大掃除！將刪除 ${isoDate} 之前的資料...`);

        await deleteOldRecords(process.env.NOTION_DATABASE_ID, isoDate, "飲食");

        if (process.env.NOTION_EXERCISE_DATABASE_ID) {
            await deleteOldRecords(
                process.env.NOTION_EXERCISE_DATABASE_ID,
                isoDate,
                "運動",
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
                `✅ [${dbName}] ID 轉換成功！使用 Data Source ID: ${dataSourceId}`,
            );
        } else {
            console.log(
                `⚠️ [${dbName}] 找不到 data_sources，嘗試使用原 ID (可能失敗)...`,
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
            createSession(userId, { mode: "food", images: [], texts: [] });
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "喵喵！開始記錄！\n請傳送食物照片或文字說明。\n💡 提示：若要補登日期，請在文字說明補上 (如：12/25)\n結束請輸入「Ok」喵",
            });
        }

        if (text === "運動記錄" || text === "運動紀錄") {
            createSession(userId, { mode: "exercise", texts: [] });
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "請輸入運動內容喵！\n💡 提示：可包含日期 (如：12/20 慢跑)",
            });
        }
    }

    if (!userSessions[userId]) return;
    const session = userSessions[userId];

    if (session.processing) return;

    // --- 運動模式 ---
    if (
        session.mode === "exercise" &&
        event.type === "message" &&
        event.message.type === "text"
    ) {
        const text = event.message.text.trim();

        // 取消指令
        if (["取消", "結束"].includes(text)) {
            delete userSessions[userId];
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: "已取消！休息是為了走更長遠的路喵！",
            });
        }

        // 結算
        if (["ok", "分析", "計算"].includes(text.toLowerCase())) {
            if (session.texts.length === 0) {
                return lineClient.replyMessage(replyToken, {
                    type: "text",
                    text: "還沒輸入運動內容喵！請先輸入例如「慢跑 30分鐘」。",
                });
            }

            session.processing = true;
            try {
                const userName = await getUserName(userId);
                const fullText = session.texts.join(" ");
                const parsed = parseDateAndContent(fullText);

                const exerciseData = await withModelFallback((modelName) =>
                    analyzeExercise(parsed.text, defaultUserStats, modelName),
                );

                await saveExerciseToNotion(exerciseData, userName, parsed.date);
                delete userSessions[userId];

                const dateStr = parsed.date.split("T")[0];
                return lineClient.replyMessage(replyToken, {
                    type: "text",
                    text: `✅ 運動紀錄完成！(${userName})\n📅 日期：${dateStr}\n🏃 項目：${exerciseData.activity_name}\n🔥 消耗：${exerciseData.calories} kcal\n💡 筆記：${exerciseData.reasoning}`,
                });
            } catch (error) {
                console.error(error);
                if (error.is503) {
                    // 保留運動內容，讓使用者稍後直接輸入 Ok 重試
                    session.processing = false;
                    resetSessionTimer(userId, session);
                    return lineClient.replyMessage(replyToken, {
                        type: "text",
                        text: "喵喵!忙線中:3\n運動內容還留著，過一下再輸入「Ok」重試就好喵（保留 5 分鐘）",
                    });
                }
                delete userSessions[userId];
                return lineClient.replyMessage(replyToken, {
                    type: "text",
                    text: "喵喵!分析失敗",
                });
            }
        }

        // 一般文字：存起來並回覆收到
        session.texts.push(text);
        return lineClient.replyMessage(replyToken, {
            type: "text",
            text: `📝 收到！目前已記錄 ${session.texts.length} 筆內容。\n完成請輸入「Ok」開始計算喵`,
        });
    }

    // --- 飲食模式  ---
    if (session.mode === "food") {
        if (event.type === "message" && event.message.type === "image") {
            const stream = await lineClient.getMessageContent(event.message.id);
            const imageBuffer = await streamToBuffer(stream);
            session.images.push(imageBuffer.toString("base64"));

            if (session.imageReplyTimer) {
                clearTimeout(session.imageReplyTimer);
            }

            session.imageReplyTimer = setTimeout(async () => {
                await lineClient.replyMessage(replyToken, {
                    type: "text",
                    text: `📸 收到了！目前 ${session.images.length} 張圖與 ${session.texts.length} 筆文字。\n還有資料請繼續上傳，若完成請輸入「Ok」喵`,
                });

                // 清空計時器
                delete session.imageReplyTimer;
            }, 800);
            return;
        }

        if (event.type === "message" && event.message.type === "text") {
            const text = event.message.text.trim();
            if (text === "分析熱量") return;

            if (["ok", "分析", "計算"].includes(text.toLowerCase())) {
                if (session.images.length === 0 && session.texts.length === 0)
                    return lineClient.replyMessage(replyToken, {
                        type: "text",
                        text: "沒資料喵！",
                    });

                session.processing = true;
                try {
                    let finalDate = new Date().toISOString();
                    let cleanTexts = [];

                    for (let t of session.texts) {
                        const parsed = parseDateAndContent(t);
                        if (parsed.found) {
                            finalDate = parsed.date;
                        }
                        if (parsed.text.length > 0) {
                            cleanTexts.push(parsed.text);
                        }
                    }

                    const foodData = await withModelFallback((modelName) =>
                        analyzeSessionData(
                            session.images,
                            cleanTexts,
                            modelName,
                        ),
                    );

                    const userName = await getUserName(userId);

                    // 存檔
                    await saveToNotion(foodData, userName, finalDate);

                    delete userSessions[userId];

                    const cals = foodData.calories || 0;
                    const dateStr = finalDate.split("T")[0];

                    return lineClient.replyMessage(replyToken, {
                        type: "text",
                        text: `🍽️ 分析完成！\n📅 日期：${dateStr}\n👤 ${userName}\n🍱 ${
                            foodData.food_name
                        }\n🔥 ${cals} kcal\n🥚 蛋白質：${
                            foodData.protein || 0
                        }g\n🥔 碳水：${foodData.carbs || 0}g\n🥓 脂肪：${
                            foodData.fat || 0
                        }g\n\n已寫入資料庫喵！`,
                    });
                } catch (error) {
                    console.error(error);
                    if (error.is503) {
                        // 保留照片與文字，讓使用者稍後直接輸入 Ok 重試
                        session.processing = false;
                        resetSessionTimer(userId, session);
                        return lineClient.replyMessage(replyToken, {
                            type: "text",
                            text: "喵喵!忙線中:3\n照片跟文字都還留著，過一下再輸入「Ok」重試就好喵（保留 5 分鐘）",
                        });
                    }
                    delete userSessions[userId];
                    return lineClient.replyMessage(replyToken, {
                        type: "text",
                        text: "喵喵!分析失敗",
                    });
                }
            }

            if (["取消", "結束"].includes(text)) {
                delete userSessions[userId];
                return lineClient.replyMessage(replyToken, {
                    type: "text",
                    text: "已取消！我要回去睡覺了喵！",
                });
            }

            session.texts.push(text);
            return lineClient.replyMessage(replyToken, {
                type: "text",
                text: `📝 文字已記錄！\n目前 ${session.images.length} 張圖與 ${session.texts.length} 筆文字。`,
            });
        }
    }
    return;
}

/**
 * 食物營養分析用的 Gemini 提示詞
 */
const FOOD_ANALYSIS_PROMPT = `你是一位具備 10 年經驗、講求「精準數據」與「臨床實務」的資深營養師。

你的任務是根據使用者提供的「圖片、文字或圖片＋文字」，估算食物的熱量與三大營養素。

【一、圖片與文字的關係判斷】

使用者提供的圖片與文字可能有以下三種情況，必須先判斷兩者的關係：

1. 補充說明
如果文字是在描述圖片中的食物、份量、烹調方式、食用程度或特殊處理方式，則圖片與文字屬於「同一份食物」。
例如：
- 圖片：一個便當
- 文字：「白飯只吃一半」
→ 文字是圖片的補充資訊，應合併判斷。

2. 不同食物
如果文字描述的是圖片中沒有出現的另一項食物，則圖片與文字代表「不同食物」，不得合併計算。
例如：
- 圖片：牛肉麵
- 文字：「另外還吃了一顆茶葉蛋」
→ 應分別計算牛肉麵與茶葉蛋。

3. 無法判斷
如果無法確定文字是在補充圖片，或是在描述另一項食物，應優先依照文字與圖片中的具體資訊判斷。
不得為了強行合併而假設兩者是同一份食物。

【二、食物拆分規則】

你只負責辨識與估算「單一品項」，不得做任何加總。總和由系統程式計算。

必須將餐點拆分成可分辨的單一食材或菜色，每一項分開估算，不得以整份餐點合併估算。

常見的拆分單位：
- 白飯、麵、麵包等主食
- 主菜
- 每一道配菜
- 蛋
- 湯品
- 飲料
- 額外加點的食物

例如：
圖片：雞腿便當
文字：「另外喝了一杯無糖紅茶」
→ 分成「白飯」、「滷雞腿」、「炒高麗菜」、「滷蛋」、「無糖紅茶」等實際看得到的品項。

例如：
圖片：牛肉麵
→ 分成「麵條」、「牛肉」、「湯頭」。

只有本身無法分開的食物才視為單一品項，例如：三明治、漢堡、水餃、飯糰、珍珠奶茶。
此時醬料、內餡、配料一律計入該品項內，不需另外拆出。

【三、份量估算邏輯】

若圖片中沒有比例尺，請依據台灣常見外食份量估算。

可參考以下常見份量：
- 白飯一碗：約 150～200g
- 便當白飯：約 200～300g
- 一般麵食：約 200～300g 熟麵
- 一份肉類：約 80～150g
- 一顆雞蛋：約 50～60g
- 一杯飲料：約 350～700ml

以上僅作為估算基準，應依圖片實際大小調整。

不得假裝知道精確重量。
如果無法確認，使用合理的台灣外食常見份量進行估算，並在 reasoning 中說明估計份量。

【四、烹調方式與隱性熱量】

必須根據食物的烹調方式估算看不見的油脂與調味料。

以下情況需要特別考慮額外油脂：
- 油炸
- 煎
- 炒
- 烤
- 酥炸
- 勾芡
- 麻辣、紅油類
- 奶油／起司料理
- 濃郁醬汁

油脂換算：
1g 脂肪 = 9 kcal。

如果無法知道實際用油量，請依照台灣外食常見烹調方式估算合理油脂，不得假設完全無油。

例如：
- 炒青菜：應估算炒菜油
- 炒飯：應估算炒飯用油
- 炸雞：應考慮炸油及裹粉吸油
- 滷肉：應考慮肉本身脂肪與滷汁
- 義大利麵：應考慮橄欖油、奶油或醬汁
- 沙拉：若有沙拉醬，必須估算醬料熱量

【五、營養素估算】

請估算：
- calories：總熱量，單位 kcal
- protein：蛋白質，單位 g
- fat：脂肪，單位 g
- carbs：碳水化合物，單位 g

營養素與熱量應保持基本合理性：

熱量 ≈
蛋白質 × 4
＋ 碳水化合物 × 4
＋ 脂肪 × 9

允許因四捨五入、纖維、糖醇或估算誤差存在合理差異，但不可出現明顯矛盾。

【六、澱粉分析】

判斷澱粉來源與精緻程度。

例如：
- 白飯 → 精緻穀物
- 白麵 → 精緻澱粉
- 糙米 → 全穀
- 燕麥 → 通常屬較完整穀物
- 地瓜 → 未精製澱粉來源

如果無法從圖片判斷食材種類，不得自行假設為全穀。

【七、蛋白質分析】

辨識主要蛋白質來源，並估算其脂肪程度。

可區分：
- 低脂：雞胸、里肌、白肉魚、蝦等
- 中脂：雞腿、瘦牛肉、豬肉等
- 高脂：五花肉、培根、香腸、炸肉等

若食物經過油炸或裹粉，即使原本肉類脂肪較低，也必須將額外油脂納入估算。

【八、隱形熱量】

特別注意以下來源：
- 烹調油
- 沙拉醬
- 美乃滋
- 奶油
- 起司
- 糖
- 蜂蜜
- 濃縮醬汁
- 勾芡
- 炸粉
- 飲料中的糖

如果圖片無法確認是否有醬料，應依視覺線索判斷，不要無條件加入大量醬料。

【九、估算原則】

這是「估算」，不是醫療檢驗或食品實驗室分析。

如果資訊不足：
- 使用台灣常見外食份量作為基準。
- 不要捏造品牌、食材重量或精確烹調油量。
- 應選擇合理的中間估計值。
- reasoning 中簡短說明主要估算依據。

如果使用者明確提供份量，例如：
「白飯150g」
「雞胸肉100g」
「只吃半碗」
則優先使用使用者提供的數據，不要再使用一般份量覆蓋。

【十、輸出格式】

輸出一個物件，包含 meal_name 與 items 兩個欄位。

meal_name：這一餐的簡短名稱，用於紀錄標題，限 20 字。
- 以一般人會怎麼稱呼這餐來命名，例如「滷雞腿便當、無糖紅茶」、「牛肉麵、茶葉蛋」。
- 不要逐一列出所有拆分後的品項。

items：拆分後的單一品項陣列。
- 每個品項輸出一個物件。
- 即使只有一個品項，仍然輸出陣列。
- 按照使用者提供的順序輸出。

禁止事項：
- 不得輸出「總計」、「合計」或任何加總後的物件。
- 不得在任何欄位中寫出多個品項加總後的數值。
- 每個物件的數值只能代表該單一品項。

只能輸出純 JSON，不得包含 Markdown、說明文字或 \`\`\`。

JSON 格式：

{
  "meal_name": "餐點簡短名稱",
  "items": [
    {
      "food_name": "單一品項名稱",
      "calories": 0,
      "protein": 0,
      "fat": 0,
      "carbs": 0,
      "confidence": "high",
      "reasoning": "限40字，說明份量估計及烹調油脂或醬料的考量。"
    }
  ]
}

所有數值皆使用數字，不要加入單位或文字。

confidence 只能是以下三個值之一：
- high：食物種類與份量都很清楚
- medium：食物清楚，但份量或烹調方式部分不確定
- low：圖片模糊、份量不明或食物種類難以辨識

語言：繁體中文，使用台灣常用用語。`;

/**
 * 把 AI 回傳的各品項加總成一筆紀錄（AI 只估算單一品項，加總一律在這裡處理）
 * 相容三種格式：{ meal_name, items: [...] }、[...]、單一品項物件
 */
function combineFoodItems(data) {
    let items;
    let mealName = "";
    if (Array.isArray(data)) {
        items = data;
    } else if (Array.isArray(data?.items)) {
        items = data.items;
        mealName = data.meal_name || "";
    } else {
        items = [data];
    }

    // 過濾掉 AI 自行加上的總計項目，避免重複計算
    items = items.filter(
        (item) =>
            item &&
            !/總計|合計|加總|total/i.test(item.food_name || item.name || ""),
    );
    if (items.length === 0) throw new Error("AI 回傳內容沒有可用的食物品項");

    console.log(`💡 共 ${items.length} 個品項，開始合併計算...`);

    // 定義一個小工具：四捨五入到小數點第 1 位
    const round = (num) => Math.round(num * 10) / 10;
    // AI 可能回傳字串數字，先轉成數字再加總，避免變成字串串接
    const sumOf = (key) =>
        items.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
    const nameOf = (item) => item.food_name || item.name || "未知品項";

    return {
        food_name: mealName || items.map(nameOf).join(" + "),
        calories: Math.round(sumOf("calories")),
        protein: round(sumOf("protein")),
        fat: round(sumOf("fat")),
        carbs: round(sumOf("carbs")),
        // 多項食物合併時，取最低的信心等級
        confidence:
            ["low", "medium", "high"].find((level) =>
                items.some((item) => item.confidence === level),
            ) || "medium",
        reasoning: items
            .filter((item) => item.reasoning)
            .map((item) => `${nameOf(item)}：${item.reasoning}`)
            .join("\n"),
    };
}

/**
 * Gemini 分析
 */
async function analyzeSessionData(
    images,
    texts,
    modelName = GEMINI_MODELS[0],
) {
    try {
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: "application/json" },
        });

        let promptText = FOOD_ANALYSIS_PROMPT;

        if (texts.length > 0) promptText += `\n補充說明：${texts.join("、")}`;

        const imageParts = images.map((base64) => ({
            inlineData: { data: base64, mimeType: "image/jpeg" },
        }));
        const result = await model.generateContent([promptText, ...imageParts]);
        const raw = result.response.text();
        console.log("AI 回傳的原始內容:", raw);
        let data;
        try {
            data = parseGeminiJson(raw);
        } catch (parseErr) {
            console.error("JSON 解析失敗，重新請求一次:", parseErr.message);
            const retryResult = await model.generateContent([
                promptText,
                ...imageParts,
            ]);
            const retryRaw = retryResult.response.text();
            console.log("AI 重試回傳的原始內容:", retryRaw);
            data = parseGeminiJson(retryRaw);
        }

        return combineFoodItems(data);
    } catch (error) {
        console.error("Gemini Error:", error);
        if (isRetryableGeminiError(error)) {
            const e = new Error("SERVICE_UNAVAILABLE");
            e.is503 = true;
            throw e;
        }
        throw error;
    }
}

/**
 * 運動熱量估算
 */
async function analyzeExercise(
    text,
    userStats,
    modelName = GEMINI_MODELS[0],
) {
    try {
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: "application/json" },
        });

        const currentUserStats = userStats || "一般成年人 (體重約 65 公斤)";

        const promptText = `你是一位專業健身教練。
        請根據使用者的身體數據：【${currentUserStats}】。
        以及運動內容：「${text}」，估算該使用者的熱量消耗。

        請回傳純 JSON 格式：
        {
            "activity_name": "標準化的運動名稱 (String)",
            "calories": 消耗熱量數值 (Number, 請依據體重做精確估算),
            "reasoning": "簡短估算理由 (String, 需提到是依據該體重計算, 限 50 字)"
        }

        請用繁體中文。`;

        const result = await model.generateContent(promptText);
        const raw = result.response.text();
        console.log("🏃 運動分析結果:", raw);
        try {
            return parseGeminiJson(raw);
        } catch (parseErr) {
            console.error(
                "運動分析 JSON 解析失敗，重新請求一次:",
                parseErr.message,
            );
            const retryResult = await model.generateContent(promptText);
            const retryRaw = retryResult.response.text();
            console.log("🏃 運動分析重試結果:", retryRaw);
            return parseGeminiJson(retryRaw);
        }
    } catch (error) {
        console.error("運動分析失敗:", error);
        if (isRetryableGeminiError(error)) {
            const e = new Error("SERVICE_UNAVAILABLE");
            e.is503 = true;
            throw e;
        }
        throw error;
    }
}

// 存檔工具
// 飲食存檔
async function saveToNotion(data, userName, recordDate) {
    // 如果沒有傳入日期，就防呆使用當下時間
    const dateToUse = recordDate || new Date().toISOString();

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
            Date: { date: { start: dateToUse } },
        },
    });
}

// 運動存檔
async function saveExerciseToNotion(data, userName, recordDate) {
    const dateToUse = recordDate || new Date().toISOString();

    await notion.pages.create({
        parent: { database_id: process.env.NOTION_EXERCISE_DATABASE_ID },
        properties: {
            Name: {
                title: [
                    { text: { content: data.activity_name || "未知運動" } },
                ],
            },
            Calories: { number: data.calories || 0 },
            User: { rich_text: [{ text: { content: userName } }] },
            Date: { date: { start: dateToUse } },
            Note: { rich_text: [{ text: { content: data.reasoning || "" } }] },
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

async function getUserName(userId) {
    try {
        const profile = await lineClient.getProfile(userId);
        return profile.displayName;
    } catch (e) {
        return "未知使用者";
    }
}

const SESSION_TTL_MS = 5 * 60 * 1000;

function createSession(userId, session) {
    const oldSession = userSessions[userId];
    if (oldSession) clearTimeout(oldSession.expireTimer);

    userSessions[userId] = session;
    resetSessionTimer(userId, session);
}

/**
 * 重新計算 session 的過期時間（從現在起 SESSION_TTL_MS 後清除）
 */
function resetSessionTimer(userId, session) {
    clearTimeout(session.expireTimer);
    session.expireTimer = setTimeout(() => {
        // 只清掉同一個 session，避免誤刪之後新建的 session
        if (userSessions[userId] === session) delete userSessions[userId];
    }, SESSION_TTL_MS);
}

/**
 * 判斷 Gemini 錯誤是否可切換模型重試：
 * - 503：模型滿載
 * - 429：該模型額度用完（免費額度依模型分開計算，換模型通常可用）
 * - fetch failed：網路層失敗
 */
function isRetryableGeminiError(error) {
    if (error?.status === 503 || error?.status === 429) return true;
    return error instanceof TypeError && error.message === "fetch failed";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 依 GEMINI_MODELS 順序呼叫 fn(modelName)，遇到 503／網路失敗就等一下再換下一個模型
 * 等待時間逐次加長（1 秒、2 秒…），給伺服器喘息的時間
 */
async function withModelFallback(fn) {
    let lastErr;
    for (const [i, modelName] of GEMINI_MODELS.entries()) {
        try {
            return await fn(modelName);
        } catch (err) {
            if (!err.is503) throw err;
            lastErr = err;
            const next = GEMINI_MODELS[i + 1];
            if (next) {
                const delayMs = (i + 1) * 1000;
                console.log(
                    `${modelName} 暫時無法使用，${delayMs / 1000} 秒後切換至 ${next} 重試...`,
                );
                await sleep(delayMs);
            }
        }
    }
    throw lastErr;
}

function parseGeminiJson(responseText) {
    const cleaned = responseText
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

    // Gemini 有時會在合法 JSON 後面多吐出文字，裁掉開頭大括號/中括號之外
    // 以及對應結尾之後的所有內容，只保留第一個完整、括號配對平衡的區塊。
    const start = cleaned.search(/[{[]/);
    if (start === -1) return JSON.parse(cleaned);

    const openChar = cleaned[start];
    const closeChar = openChar === "{" ? "}" : "]";
    const jsonStr = extractBalancedJson(cleaned, start, openChar, closeChar);

    try {
        return JSON.parse(jsonStr);
    } catch (err) {
        // Gemini 偶爾會在字串內容（例如 reasoning 自由文字）吐出未跳脫的引號，
        // 導致字串提前結束、後面內容變成不合法的 token。嘗試自動補上跳脫符號後再解析一次。
        return JSON.parse(repairUnescapedQuotes(jsonStr));
    }
}

/**
 * 從 start 開始，依括號深度找出第一個完整、配對平衡的 JSON 區塊。
 * 掃描時會追蹤是否位於字串內，避免字串內容裡剛好出現 {}/[] 字元干擾配對。
 */
function extractBalancedJson(text, start, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") i++;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === openChar) depth++;
        else if (ch === closeChar) {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    return end === -1 ? text.slice(start) : text.slice(start, end + 1);
}

/**
 * 修補字串內未跳脫的雙引號：逐字掃描字串內容，遇到後面緊接的不是
 * 逗號/冒號/收尾括號（或結尾）的引號，視為內容裡的引號而非字串結尾，
 * 自動補上跳脫符號再交給 JSON.parse。
 */
function repairUnescapedQuotes(jsonStr) {
    let result = "";
    let inString = false;
    for (let i = 0; i < jsonStr.length; i++) {
        const ch = jsonStr[i];
        if (!inString) {
            result += ch;
            if (ch === '"') inString = true;
            continue;
        }
        if (ch === "\\") {
            result += ch + (jsonStr[i + 1] ?? "");
            i++;
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            while (j < jsonStr.length && /\s/.test(jsonStr[j])) j++;
            const next = jsonStr[j];
            const isRealEnd =
                next === undefined ||
                next === "," ||
                next === "}" ||
                next === "]" ||
                next === ":";
            if (isRealEnd) {
                inString = false;
                result += ch;
            } else {
                result += '\\"';
            }
            continue;
        }
        result += ch;
    }
    return result;
}

// 日期解析小工具
function parseDateAndContent(text) {
    // 支援格式：YYYY/MM/DD, YYYY-MM-DD, MM/DD, MM-DD
    const fullDateRegex = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/; // 抓 2025/12/25
    const shortDateRegex = /(\d{1,2})[-\/](\d{1,2})/; // 抓 12/25

    let targetDate = new Date();
    let cleanText = text;
    let found = false;

    // 1. 先找完整日期 (YYYY/MM/DD)
    const fullMatch = text.match(fullDateRegex);
    if (fullMatch) {
        // fullMatch[0] 是抓到的日期字串
        targetDate = new Date(fullMatch[0]);
        // 把日期從文字中移除，剩下的就是內容
        cleanText = text.replace(fullMatch[0], "").trim();
        found = true;
    } else {
        const shortMatch = text.match(shortDateRegex);
        if (shortMatch) {
            const currentYear = new Date().getFullYear();
            const month = shortMatch[1];
            const day = shortMatch[2];
            // 組合日期字串
            targetDate = new Date(`${currentYear}-${month}-${day}`);
            cleanText = text.replace(shortMatch[0], "").trim();
            found = true;
        }
    }

    targetDate.setHours(12, 0, 0, 0);

    return {
        date: targetDate.toISOString(), // 轉成 Notion 看得懂的 ISO 格式
        text: cleanText,
        found: found,
    };
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`listening on ${port}`);
});
