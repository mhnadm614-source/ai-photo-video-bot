const TELEGRAM_API = "https://api.telegram.org";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("ai-photo-video-bot is running", { status: 200 });
    }

    // One-time setup endpoint. Keep SETUP_SECRET private.
    if (url.pathname === "/setup" && request.method === "POST") {
      const supplied = url.searchParams.get("key");
      if (!env.SETUP_SECRET || supplied !== env.SETUP_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return new Response("Missing BOT_TOKEN or WEBHOOK_SECRET", { status: 500 });
      }

      const webhookUrl = `${url.origin}/telegram`;
      const result = await telegram(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false
      });
      return Response.json(result);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.WEBHOOK_SECRET || headerSecret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      try {
        if (update.message) await handleMessage(update.message, env);
        if (update.callback_query) await handleCallback(update.callback_query, env);
      } catch (error) {
        console.error("Update handling failed:", error);
      }
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function telegram(env, method, payload) {
  const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    console.error("Telegram API error:", data);
    throw new Error(data.description || `Telegram API ${method} failed`);
  }
  return data;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function handleMessage(message, env) {
  if (!message.from || !message.chat) return;
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  // Only private chats are supported for bot commands and media intake.
  if (message.chat.type !== "private") return;

  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const payload = parts[1] || "";
    const referrerId = payload.startsWith("ref_")
      ? Number(payload.slice(4))
      : null;
    await registerUser(env, message.from, referrerId);
    const name = message.from.first_name || "صديقي";
    await sendMessage(
      env,
      chatId,
      `أهلاً ${name} 👋\n\nأرسل صورة أو فيديو للبدء.\n\nالأوامر المتاحة:\n/balance - رصيد نقاطك\n/daily - مكافأة الدخول اليومية\n/invite - رابط دعوة الأصدقاء\n/help - المساعدة`
    );
    return;
  }

  await ensureUser(env, message.from);

  if (text.startsWith("/daily")) {
    const result = await claimDaily(env, userId);
    if (result.claimed) {
      await sendMessage(env, chatId, `🎁 حصلت على ${result.points} نقاط للدخول اليومي!\nرصيدك الآن: ${result.balance} نقطة.`);
    } else {
      await sendMessage(env, chatId, `لقد حصلت على مكافأتك اليومية بالفعل.\nرصيدك: ${result.balance} نقطة.`);
    }
    return;
  }

  if (text.startsWith("/balance")) {
    const user = await env.DB.prepare(
      "SELECT points FROM users WHERE telegram_id = ?"
    ).bind(userId).first();
    await sendMessage(env, chatId, `رصيدك الحالي: ${user?.points ?? 0} نقطة.`);
    return;
  }

  if (text.startsWith("/invite")) {
    const me = await telegram(env, "getMe", {});
    const botUsername = me.result.username;
    const link = `https://t.me/${botUsername}?start=ref_${userId}`;
    await sendMessage(env, chatId, `🎉 ادعُ أصدقاءك واحصل على 5 نقاط عن كل مستخدم جديد.\n\nرابط دعوتك:\n${link}\n\nتُحتسب الدعوة مرة واحدة فقط لكل مستخدم.`);
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(env, chatId, "أرسل صورة أو فيديو إلى البوت. استخدم /daily للحصول على مكافأة يومية، و/balance لمعرفة رصيدك، و/invite لدعوة الأصدقاء.");
    return;
  }

  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    await saveMedia(env, userId, "photo", photo.file_id);
    await sendMessage(env, chatId, "📷 وصلتني الصورة بنجاح. ميزة تعديل الصور بالذكاء الاصطناعي سنربطها في المرحلة التالية.");
    return;
  }

  if (message.video) {
    await saveMedia(env, userId, "video", message.video.file_id);
    await sendMessage(env, chatId, "🎬 وصلني الفيديو بنجاح. سنضيف أدوات معالجة الفيديو في المرحلة التالية.");
    return;
  }

  if (message.document) {
    await saveMedia(env, userId, "document", message.document.file_id);
    await sendMessage(env, chatId, "📎 وصلني الملف بنجاح.");
    return;
  }

  await sendMessage(env, chatId, "أرسل صورة أو فيديو، أو اختر أحد الأوامر:\n/daily\n/balance\n/invite\n/help");
}

async function registerUser(env, from, referrerId) {
  const existing = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE telegram_id = ?"
  ).bind(from.id).first();

  if (existing) return;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO users
     (telegram_id, username, first_name, points, created_at)
     VALUES (?, ?, ?, 0, ?)`
  ).bind(
    from.id,
    from.username || null,
    from.first_name || null,
    new Date().toISOString()
  ).run();

  // Never award self-referrals; the unique referred_user_id prevents duplicates.
  if (referrerId && Number.isSafeInteger(referrerId) &&
      referrerId !== from.id) {
    const referrer = await env.DB.prepare(
      "SELECT telegram_id FROM users WHERE telegram_id = ?"
    ).bind(referrerId).first();

    if (referrer) {
      const insert = await env.DB.prepare(
        `INSERT OR IGNORE INTO referrals
         (referrer_id, referred_user_id, created_at)
         VALUES (?, ?, ?)`
      ).bind(referrerId, from.id, new Date().toISOString()).run();

      if (insert.meta?.changes > 0) {
        await env.DB.prepare(
          "UPDATE users SET points = points + 5 WHERE telegram_id = ?"
        ).bind(referrerId).run();
        await sendMessage(env, referrerId, "🎉 انضم صديق جديد عبر رابطك! أضفنا 5 نقاط إلى رصيدك.");
      }
    }
  }
}

async function ensureUser(env, from) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users
     (telegram_id, username, first_name, points, created_at)
     VALUES (?, ?, ?, 0, ?)`
  ).bind(
    from.id,
    from.username || null,
    from.first_name || null,
    new Date().toISOString()
  ).run();
}

async function claimDaily(env, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const points = 2;

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO daily_claims (telegram_id, claim_date, points)
     VALUES (?, ?, ?)`
  ).bind(userId, today, points).run();

  if (result.meta?.changes > 0) {
    await env.DB.prepare(
      "UPDATE users SET points = points + ? WHERE telegram_id = ?"
    ).bind(points, userId).run();
  }

  const user = await env.DB.prepare(
    "SELECT points FROM users WHERE telegram_id = ?"
  ).bind(userId).first();

  return {
    claimed: result.meta?.changes > 0,
    points,
    balance: user?.points ?? 0
  };
}

async function saveMedia(env, userId, mediaType, fileId) {
  await env.DB.prepare(
    `INSERT INTO media_uploads (telegram_id, media_type, file_id, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(userId, mediaType, fileId, new Date().toISOString()).run();
}

async function handleCallback(query, env) {
  await telegram(env, "answerCallbackQuery", {
    callback_query_id: query.id,
    text: "تم"
  });
}
