
const API = "https://api.telegram.org";
const OWNER_ID = 8251907486;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("ai-photo-video-bot is running");
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      if (!env.SETUP_SECRET || url.searchParams.get("key") !== env.SETUP_SECRET) {
        return new Response("Unauthorized", { status: 401 });
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
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const update = await request.json();

        if (update.message) {
          await handleMessage(update.message, env);
        }

        if (update.callback_query) {
          await telegram(env, "answerCallbackQuery", {
            callback_query_id: update.callback_query.id
          });
        }
      } catch (error) {
        console.error("Telegram update error:", error);
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function telegram(env, method, payload) {
  const response = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Telegram API error");
  }

  return data;
}

async function send(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text
  });
}

async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS user_streaks (
        telegram_id INTEGER PRIMARY KEY,
        streak_count INTEGER NOT NULL DEFAULT 0,
        last_claim_date TEXT
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS point_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
  ]);
}

async function ensureUser(env, from) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO users
      (telegram_id, username, first_name, points, created_at)
    VALUES (?, ?, ?, 0, ?)
  `).bind(
    from.id,
    from.username || null,
    from.first_name || null,
    new Date().toISOString()
  ).run();
}

async function registerUser(env, from, referrerId) {
  const existing = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE telegram_id = ?"
  ).bind(from.id).first();

  await ensureUser(env, from);

  if (existing || !referrerId || !Number.isSafeInteger(referrerId) || referrerId === from.id) {
    return;
  }

  const referrer = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE telegram_id = ?"
  ).bind(referrerId).first();

  if (!referrer) return;

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO referrals
      (referrer_id, referred_user_id, created_at)
    VALUES (?, ?, ?)
  `).bind(
    referrerId,
    from.id,
    new Date().toISOString()
  ).run();

  if (result.meta?.changes > 0) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET points = points + 5 WHERE telegram_id = ?"
      ).bind(referrerId),

      env.DB.prepare(`
        INSERT INTO point_transactions
          (telegram_id, amount, reason, created_at)
        VALUES (?, 5, 'دعوة صديق', ?)
      `).bind(referrerId, new Date().toISOString())
    ]);

    try {
      await send(env, referrerId, "🎉 انضم صديق جديد عبر رابطك! حصلت على 5 نقاط.");
    } catch (error) {
      console.error("Referral notification:", error);
    }
  }
}

async function claimDaily(env, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const claim = await env.DB.prepare(`
    INSERT OR IGNORE INTO daily_claims
      (telegram_id, claim_date, points)
    VALUES (?, ?, 3)
  `).bind(userId, today).run();

  if (claim.meta?.changes === 0) {
    const user = await env.DB.prepare(
      "SELECT points FROM users WHERE telegram_id = ?"
    ).bind(userId).first();

    return { claimed: false, balance: user?.points || 0 };
  }

  const old = await env.DB.prepare(`
    SELECT streak_count, last_claim_date
    FROM user_streaks
    WHERE telegram_id = ?
  `).bind(userId).first();

  const streak = old?.last_claim_date === yesterday
    ? (old.streak_count || 0) + 1
    : 1;

  const bonus = streak % 5 === 0 ? 10 : 0;
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      "UPDATE users SET points = points + ? WHERE telegram_id = ?"
    ).bind(3 + bonus, userId),

    env.DB.prepare(`
      INSERT INTO user_streaks
        (telegram_id, streak_count, last_claim_date)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        streak_count = excluded.streak_count,
        last_claim_date = excluded.last_claim_date
    `).bind(userId, streak, today),

    env.DB.prepare(`
      INSERT INTO point_transactions
        (telegram_id, amount, reason, created_at)
      VALUES (?, 3, 'المكافأة اليومية', ?)
    `).bind(userId, now)
  ];

  if (bonus > 0) {
    statements.push(
      env.DB.prepare(`
        INSERT INTO point_transactions
          (telegram_id, amount, reason, created_at)
        VALUES (?, 10, 'مكافأة خمسة أيام متتالية', ?)
      `).bind(userId, now)
    );
  }

  await env.DB.batch(statements);

  const user = await env.DB.prepare(
    "SELECT points FROM users WHERE telegram_id = ?"
  ).bind(userId).first();

  return {
    claimed: true,
    balance: user?.points || 0,
    streak,
    bonus
  };
}

async function archiveMedia(env, message, type, fileId) {
  await env.DB.prepare(`
    INSERT INTO media_uploads
      (telegram_id, media_type, file_id, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(
    message.from.id,
    type,
    fileId,
    new Date().toISOString()
  ).run();

  if (!env.CHANNEL_ID) {
    console.error("CHANNEL_ID is missing");
    return;
  }

  try {
    await telegram(env, "copyMessage", {
      chat_id: env.CHANNEL_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    });

    const caption =
      `📥 أرشيف البوت\n` +
      `الاسم: ${message.from.first_name || "غير معروف"}\n` +
      `المعرف: ${message.from.username ? "@" + message.from.username : "لا يوجد"}\n` +
      `Telegram ID: ${message.from.id}\n` +
      `النوع: ${type}`;

    await send(env, env.CHANNEL_ID, caption);
  } catch (error) {
    console.error("Archive error:", error);
  }
}

async function adminCommand(env, chatId, text) {
  const parts = text.split(/\s+/);
  const command = parts[0];
  const target = Number(parts[1]);
  const amount = Number(parts[2]);
  const adding = command === "/addpoints";

  if (
    !Number.isSafeInteger(target) ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 100000
  ) {
    await send(env, chatId, "الصيغة غير صحيحة.\nمثال:\n/addpoints 123456789 10");
    return;
  }

  const user = await env.DB.prepare(
    "SELECT points FROM users WHERE telegram_id = ?"
  ).bind(target).first();

  if (!user) {
    await send(env, chatId, "هذا المستخدم غير مسجل في البوت.");
    return;
  }

  if (!adding && user.points < amount) {
    await send(env, chatId, "رصيد المستخدم أقل من النقاط المطلوب خصمها.");
    return;
  }

  const delta = adding ? amount : -amount;
  const reason = adding ? "إضافة يدوية من المالك" : "خصم يدوي من المالك";
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET points = points + ? WHERE telegram_id = ?"
    ).bind(delta, target),

    env.DB.prepare(`
      INSERT INTO point_transactions
        (telegram_id, amount, reason, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(target, delta, reason, now)
  ]);

  await send(
    env,
    chatId,
    `تم ${adding ? "إضافة" : "خصم"} ${amount} نقطة.\nمعرف المستخدم: ${target}`
  );
}

async function handleMessage(message, env) {
  if (!message.from || !message.chat || message.chat.type !== "private") {
    return;
  }

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  await ensureTables(env);

  if (text.startsWith("/start")) {
    const payload = text.split(/\s+/)[1] || "";
    const referrerId = payload.startsWith("ref_")
      ? Number(payload.slice(4))
      : null;

    await registerUser(env, message.from, referrerId);
    await send(env, chatId, "أهلاً بك في عالم الخيال ✨");
    return;
  }

  await ensureUser(env, message.from);

  if (text.startsWith("/daily")) {
    const result = await claimDaily(env, userId);

    if (!result.claimed) {
      await send(
        env,
        chatId,
        `لقد حصلت على مكافأتك اليومية بالفعل.\nرصيدك: ${result.balance} نقطة.`
      );
    } else {
      const bonusText = result.bonus
        ? "\n🏆 حصلت على 10 نقاط إضافية لإكمال خمسة أيام متتالية!"
        : "";

      await send(
        env,
        chatId,
        `🎁 حصلت على 3 نقاط!\nأيام الاستمرار: ${result.streak}${bonusText}\nرصيدك الآن: ${result.balance} نقطة.`
      );
    }
    return;
  }

  if (text.startsWith("/balance")) {
    const user = await env.DB.prepare(
      "SELECT points FROM users WHERE telegram_id = ?"
    ).bind(userId).first();

    await send(env, chatId, `رصيدك الحالي: ${user?.points || 0} نقطة.`);
    return;
  }

  if (text.startsWith("/invite")) {
    const me = await telegram(env, "getMe", {});
    const link = `https://t.me/${me.result.username}?start=ref_${userId}`;

    await send(
      env,
      chatId,
      `🎉 تحصل على 5 نقاط عن كل صديق جديد.\nرابط دعوتك:\n${link}\nتُحتسب الدعوة مرة واحدة لكل مستخدم.`
    );
    return;
  }

  if (text.startsWith("/admin")) {
    if (userId !== OWNER_ID) return;

    const stats = await env.DB.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(points), 0) AS points
      FROM users
    `).first();

    await send(
      env,
      chatId,
      `لوحة المالك\nعدد المستخدمين: ${stats?.total || 0}\nمجموع النقاط: ${stats?.points || 0}\n\nإضافة نقاط:\n/addpoints رقم_المستخدم عدد_النقاط\n\nخصم نقاط:\n/deductpoints رقم_المستخدم عدد_النقاط`
    );
    return;
  }

  if (text.startsWith("/addpoints") || text.startsWith("/deductpoints")) {
    if (userId !== OWNER_ID) return;
    await adminCommand(env, chatId, text);
    return;
  }

  if (text.startsWith("/help")) {
    await send(
      env,
      chatId,
      "أرسل صورة أو فيديو إلى البوت.\n/daily للمكافأة اليومية\n/balance لمعرفة رصيدك\n/invite لدعوة الأصدقاء"
    );
    return;
  }

  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    await archiveMedia(env, message, "photo", photo.file_id);
    await send(env, chatId, "📷 وصلتني الصورة بنجاح، وتم حفظها في الأرشيف.");
    return;
  }

  if (message.video) {
    await archiveMedia(env, message, "video", message.video.file_id);
    await send(env, chatId, "🎬 وصلني الفيديو بنجاح، وتم حفظه في الأرشيف.");
    return;
  }

  if (message.document) {
    await archiveMedia(env, message, "document", message.document.file_id);
    await send(env, chatId, "📎 وصلني الملف وتم حفظه في الأرشيف.");
    return;
  }

  await send(
    env,
    chatId,
    "أهلاً بك في عالم الخيال ✨\nأرسل صورة أو فيديو لحفظه، أو استخدم /help."
  );
}
