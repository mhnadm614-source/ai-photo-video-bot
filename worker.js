
const TELEGRAM_API = "https://api.telegram.org";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("ai-photo-video-bot is running");
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      if (
        !env.SETUP_SECRET ||
        url.searchParams.get("key") !== env.SETUP_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return new Response("Missing secrets", { status: 500 });
      }

      const result = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false
      });

      return Response.json(result);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const secret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      try {
        if (update.message) {
          await handleMessage(update.message, env);
        }

        if (update.callback_query) {
          await telegram(env, "answerCallbackQuery", {
            callback_query_id: update.callback_query.id,
            text: "تم"
          });
        }
      } catch (error) {
        console.error("Update error:", error);
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function telegram(env, method, payload) {
  const response = await fetch(
    `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Telegram API error");
  }

  return data;
}

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text
  });
}

async function ensureDailyTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS daily_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      claim_date TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 2,
      UNIQUE(telegram_id, claim_date)
    )
  `).run();
}

async function ensureUser(env, from) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO users (user_id, username, points)
    VALUES (?, ?, 0)
  `).bind(
    from.id,
    from.username || null
  ).run();
}

async function registerUser(env, from, referrerId) {
  const existing = await env.DB.prepare(
    "SELECT user_id FROM users WHERE user_id = ?"
  ).bind(from.id).first();

  if (existing) {
    return;
  }

  await ensureUser(env, from);

  if (
    !referrerId ||
    !Number.isSafeInteger(referrerId) ||
    referrerId === from.id
  ) {
    return;
  }

  const referrer = await env.DB.prepare(
    "SELECT user_id FROM users WHERE user_id = ?"
  ).bind(referrerId).first();

  if (!referrer) return;

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO referrals
    (referrer_id, referred_id)
    VALUES (?, ?)
  `).bind(referrerId, from.id).run();

  if (result.meta?.changes > 0) {
    await env.DB.prepare(
      "UPDATE users SET points = points + 5 WHERE user_id = ?"
    ).bind(referrerId).run();

    try {
      await sendMessage(
        env,
        referrerId,
        "🎉 انضم صديق جديد عبر رابطك! حصلت على 5 نقاط."
      );
    } catch (error) {
      console.error("Referral notification error:", error);
    }
  }
}

async function claimDaily(env, userId) {
  await ensureDailyTable(env);

  const today = new Date().toISOString().slice(0, 10);
  const points = 2;

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO daily_claims
    (telegram_id, claim_date, points)
    VALUES (?, ?, ?)
  `).bind(userId, today, points).run();

  if (result.meta?.changes > 0) {
    await env.DB.prepare(
      "UPDATE users SET points = points + ? WHERE user_id = ?"
    ).bind(points, userId).run();
  }

  const user = await env.DB.prepare(
    "SELECT points FROM users WHERE user_id = ?"
  ).bind(userId).first();

  return {
    claimed: result.meta?.changes > 0,
    balance: user?.points || 0
  };
}

async function saveMedia(env, message, mediaType, fileId) {
  const userId = message.from.id;
  const username =
    message.from.username ||
    message.from.first_name ||
    "مستخدم";

  await env.DB.prepare(`
    INSERT INTO archive
    (user_id, username, file_id, media_type)
    VALUES (?, ?, ?, ?)
  `).bind(
    userId,
    username,
    fileId,
    mediaType
  ).run();

  const caption =
    `📥 أرشيف البوت\n` +
    `الاسم: ${message.from.first_name || "غير معروف"}\n` +
    `المعرف: @${message.from.username || "لا يوجد"}\n` +
    `Telegram ID: ${userId}\n` +
    `النوع: ${mediaType}`;

  await telegram(env, "copyMessage", {
    chat_id: env.CHANNEL_ID,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
    caption
  });
}

async function handleMessage(message, env) {
  if (!message.from || !message.chat) return;
  if (message.chat.type !== "private") return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const payload = parts[1] || "";

    const referrerId = payload.startsWith("ref_")
      ? Number(payload.slice(4))
      : null;

    await registerUser(env, message.from, referrerId);

    await sendMessage(env, chatId, "أهلاً بك في عالم الخيال ✨");
    return;
  }

  await ensureUser(env, message.from);

  if (text.startsWith("/daily")) {
    const result = await claimDaily(env, userId);

    if (result.claimed) {
      await sendMessage(
        env,
        chatId,
        `🎁 حصلت على نقطتين!\nرصيدك الآن: ${result.balance} نقطة.`
      );
    } else {
      await sendMessage(
        env,
        chatId,
        `لقد حصلت على مكافأتك اليومية بالفعل.\nرصيدك: ${result.balance} نقطة.`
      );
    }
    return;
  }

  if (text.startsWith("/balance")) {
    const user = await env.DB.prepare(
      "SELECT points FROM users WHERE user_id = ?"
    ).bind(userId).first();

    await sendMessage(
      env,
      chatId,
      `رصيدك الحالي: ${user?.points || 0} نقطة.`
    );
    return;
  }

  if (text.startsWith("/invite")) {
    const me = await telegram(env, "getMe", {});
    const link =
      `https://t.me/${me.result.username}?start=ref_${userId}`;

    await sendMessage(
      env,
      chatId,
      `🎉 ادعُ أصدقاءك واحصل على 5 نقاط عن كل مستخدم جديد.\n\nرابط دعوتك:\n${link}\n\nتُحتسب الدعوة مرة واحدة فقط لكل مستخدم.`
    );
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(
      env,
      chatId,
      "أرسل صورة أو فيديو إلى البوت.\n/daily للمكافأة اليومية\n/balance لمعرفة رصيدك\n/invite لدعوة الأصدقاء"
    );
    return;
  }

  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];

    await saveMedia(env, message, "photo", photo.file_id);

    await sendMessage(
      env,
      chatId,
      "📷 وصلتني الصورة بنجاح، وتم حفظها في الأرشيف."
    );
    return;
  }

  if (message.video) {
    await saveMedia(
      env,
      message,
      "video",
      message.video.file_id
    );

    await sendMessage(
      env,
      chatId,
      "🎬 وصلني الفيديو بنجاح، وتم حفظه في الأرشيف."
    );
    return;
  }

  if (message.document) {
    await saveMedia(
      env,
      message,
      "document",
      message.document.file_id
    );

    await sendMessage(env, chatId, "📎 وصلني الملف وتم حفظه في الأرشيف.");
    return;
  }

  await sendMessage(
    env,
    chatId,
    "أرسل صورة أو فيديو، أو استخدم /help."
  );
}
