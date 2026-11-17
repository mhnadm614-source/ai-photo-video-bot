
const API = "https://api.telegram.org";
const OWNER_ID = 8251907486;
const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

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
        allowed_updates: ["message"],
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

      try {
        const update = await request.json();
        if (update.message) await handleMessage(update.message, env);
      } catch (error) {
        console.error("Webhook error:", error);
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function telegram(env, method, payload) {
  const response = await fetch(
    `${API}/bot${env.BOT_TOKEN}/${method}`,
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

function userKeyboard() {
  return { keyboard: [
    [{ text: "🖼 تعديل صورة" }, { text: "👗 تبديل الملابس" }],
    [{ text: "🎁 المكافأة اليومية" }, { text: "💰 رصيدي" }],
    [{ text: "🔗 رابط الدعوة" }]
  ], resize_keyboard: true, is_persistent: true };
}
function ownerKeyboard() {
  return { keyboard: [
    [{ text: "🖼 تعديل صورة" }, { text: "👗 تبديل الملابس" }],
    [{ text: "⚙️ لوحة المالك" }],
    [{ text: "📢 إرسال رسالة للجميع" }],
    [{ text: "📌 تثبيت رسالة للجميع" }],
    [{ text: "📍 إلغاء تثبيت الرسائل للجميع" }],
    [{ text: "➕ إضافة نقاط للمستخدم" }, { text: "➖ خصم نقاط من المستخدم" }]
  ], resize_keyboard: true, is_persistent: true };
}
async function send(env, chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegram(env, "sendMessage", payload);
}
async function showOwnerPanel(env, chatId) {
  const stats = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();
  await send(env, chatId, "⚙️ لوحة المالك\nعدد المستخدمين: " + (stats?.total || 0) +
    "\n\nيمكنك تعديل الصور دون نقاط، وإدارة أرصدة المستخدمين من أزرار إضافة أو خصم النقاط.", ownerKeyboard());
}
async function beginAdminAction(env, userId, action, chatId, prompt) {
  await env.DB.prepare("INSERT INTO admin_actions (telegram_id, action, created_at) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET action = excluded.action, created_at = excluded.created_at")
    .bind(userId, action, new Date().toISOString()).run();
  await send(env, chatId, prompt, ownerKeyboard());
}
async function finishAdminAction(env, userId, chatId, text) {
  const pending = await env.DB.prepare("SELECT action FROM admin_actions WHERE telegram_id = ?").bind(userId).first();
  if (!pending) return false;
  await env.DB.prepare("DELETE FROM admin_actions WHERE telegram_id = ?").bind(userId).run();
  if (pending.action === "addpoints" || pending.action === "deductpoints") {
    await adminCommand(env, chatId, (pending.action === "addpoints" ? "/addpoints " : "/deductpoints ") + text);
    return true;
  }
  if (pending.action !== "broadcast" && pending.action !== "pin_broadcast") return false;
  const users = await env.DB.prepare("SELECT telegram_id FROM users").all();
  let sentCount = 0, failedCount = 0;
  for (const user of (users.results || [])) {
    try {
      const result = await send(env, user.telegram_id, text);
      if (pending.action === "pin_broadcast") {
        await telegram(env, "pinChatMessage", { chat_id: user.telegram_id, message_id: result.result.message_id, disable_notification: true });
      }
      sentCount++;
    } catch (error) {
      failedCount++;
      console.error("Broadcast error:", user.telegram_id, error);
    }
  }
  await send(env, chatId, "انتهى الإرسال.\nتم الإرسال: " + sentCount + "\nتعذر الإرسال: " + failedCount, ownerKeyboard());
  return true;
}
async function unpinForAllUsers(env, chatId) {
  const users = await env.DB.prepare("SELECT telegram_id FROM users").all();
  let done = 0, failed = 0;
  for (const user of (users.results || [])) {
    try {
      await telegram(env, "unpinAllChatMessages", { chat_id: user.telegram_id });
      done++;
    } catch (error) {
      failed++;
      console.error("Unpin error:", user.telegram_id, error);
    }
  }
  await send(env, chatId, "اكتملت العملية.\nتم إلغاء التثبيت: " + done + "\nتعذر: " + failed, ownerKeyboard());
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
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pending_edits (
        telegram_id INTEGER PRIMARY KEY,
        file_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pending_modes (
        telegram_id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS admin_actions (
        telegram_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
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
  const oldUser = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE telegram_id = ?"
  ).bind(from.id).first();

  await ensureUser(env, from);

  if (
    oldUser ||
    !referrerId ||
    !Number.isSafeInteger(referrerId) ||
    referrerId === from.id
  ) return;

  const referrer = await env.DB.prepare(
    "SELECT telegram_id FROM users WHERE telegram_id = ?"
  ).bind(referrerId).first();

  if (!referrer) return;

  // يدعم أعمدة جدول referrals القديمة والجديدة
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO referrals
      (inviter_id, invited_id, referrer_id, referred_user_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    referrerId,
    from.id,
    referrerId,
    from.id,
    new Date().toISOString()
  ).run();

  if (result.meta?.changes > 0) {
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET points = points + 5 WHERE telegram_id = ?"
      ).bind(referrerId),

      env.DB.prepare(`
        INSERT INTO point_transactions
          (telegram_id, amount, reason, created_at)
        VALUES (?, 5, 'دعوة صديق', ?)
      `).bind(referrerId, now)
    ]);

    try {
      await send(
        env,
        referrerId,
        "🎉 انضم صديق جديد عبر رابطك! حصلت على 5 نقاط."
      );
    } catch (e) {
      console.error("Referral notification:", e);
    }
  }
}

async function claimDaily(env, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000)
    .toISOString().slice(0, 10);

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
    FROM user_streaks WHERE telegram_id = ?
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

  if (bonus) {
    statements.push(env.DB.prepare(`
      INSERT INTO point_transactions
        (telegram_id, amount, reason, created_at)
      VALUES (?, 10, 'مكافأة خمسة أيام متتالية', ?)
    `).bind(userId, now));
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

async function archiveMedia(env, message, type) {
  const fileId = type === "photo"
    ? message.photo[message.photo.length - 1].file_id
    : type === "image_document"
      ? message.document.file_id
      : message.video.file_id;

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

  if (!env.CHANNEL_ID) return;

  try {
    await telegram(env, "copyMessage", {
      chat_id: env.CHANNEL_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    });

    await send(env, env.CHANNEL_ID,
      `📥 أرشيف البوت\n` +
      `الاسم: ${message.from.first_name || "غير معروف"}\n` +
      `المعرف: ${message.from.username ? "@" + message.from.username : "لا يوجد"}\n` +
      `Telegram ID: ${message.from.id}\n` +
      `النوع: ${type}`
    );
  } catch (e) {
    console.error("Archive error:", e);
  }

  return fileId;
}

async function getTelegramFile(env, fileId) {
  const result = await telegram(env, "getFile", {
    file_id: fileId
  });

  const url =
    `${API}/file/bot${env.BOT_TOKEN}/${result.result.file_path}`;

  const response = await fetch(url);

  if (!response.ok) throw new Error("تعذر تحميل الصورة");

  return await response.blob();
}

async function editImage(env, chatId, userId, fileId, prompt, mode = "normal") {
  const isOwner = userId === OWNER_ID;

  const finalPrompt = mode === "clothes_swap"
    ? "Perform a realistic clothes swap on the person in the input image. Replace the person's current outfit with clothing matching this user request: " +
      prompt +
      ". Keep the same person and facial identity, face, hairstyle, body proportions, pose, hands, camera angle, lighting, and background. Change the clothing only. Make the new outfit look natural, realistic, and properly fitted."
    : prompt;

  if (!env.AI) {
    await send(env, chatId, "خدمة تعديل الصور غير مفعّلة حالياً.");
    return;
  }

  // خصم 3 نقاط من المستخدم العادي فقط
  if (!isOwner) {
    const deduction = await env.DB.prepare(`
      UPDATE users
      SET points = points - 3
      WHERE telegram_id = ? AND points >= 3
    `).bind(userId).run();

    if (deduction.meta?.changes === 0) {
      await send(env, chatId, "رصيدك غير كافٍ. تحتاج إلى 3 نقاط للتعديل.");
      return;
    }

    await env.DB.prepare(`
      INSERT INTO point_transactions
        (telegram_id, amount, reason, created_at)
      VALUES (?, -3, 'تعديل صورة', ?)
    `).bind(userId, new Date().toISOString()).run();
  }

  try {
    await send(env, chatId, "⏳ جارٍ تعديل الصورة بالذكاء الاصطناعي...");

    const original = await getTelegramFile(env, fileId);

    const form = new FormData();
    form.append("prompt", finalPrompt);
    form.append("input_image_0", original, "original.jpg");
    form.append("width", "1024");
    form.append("height", "1024");
    form.append("guidance", "4");

    const serialized = new Response(form);

    const result = await env.AI.run(IMAGE_MODEL, {
      multipart: {
        body: serialized.body,
        contentType: serialized.headers.get("content-type")
      }
    });

    // Workers AI يعيد الصورة في result.image كسلسلة Base64، وليس كاستجابة صورة مباشرة.
    if (!result || typeof result.image !== "string" || !result.image) {
      throw new Error("لم يُرجع نموذج الصور بيانات صورة صالحة");
    }

    const imageBytes = Uint8Array.from(
      atob(result.image),
      character => character.charCodeAt(0)
    );
    const output = new Blob([imageBytes], { type: "image/png" });

    if (!output.size) throw new Error("نتيجة الصورة فارغة");

    const photoForm = new FormData();
    photoForm.append("chat_id", String(chatId));
    photoForm.append("photo", output, "edited.png");
    photoForm.append("caption", "✨ هذه هي الصورة بعد التعديل");

    const sent = await fetch(
      `${API}/bot${env.BOT_TOKEN}/sendPhoto`,
      { method: "POST", body: photoForm }
    );

    const sentData = await sent.json();
    if (!sent.ok || !sentData.ok) {
      throw new Error(sentData.description || "فشل إرسال الصورة");
    }

    // أرشفة النتيجة أيضاً
    if (env.CHANNEL_ID) {
      const archiveForm = new FormData();
      archiveForm.append("chat_id", String(env.CHANNEL_ID));
      archiveForm.append("photo", output, "edited.png");
      archiveForm.append(
        "caption",
        `✅ نتيجة التعديل\nTelegram ID: ${userId}`
      );

      await fetch(
        `${API}/bot${env.BOT_TOKEN}/sendPhoto`,
        { method: "POST", body: archiveForm }
      );
    }

    const user = await env.DB.prepare(
      "SELECT points FROM users WHERE telegram_id = ?"
    ).bind(userId).first();

    if (!isOwner) {
      await send(env, chatId, `رصيدك المتبقي: ${user?.points || 0} نقطة.`);
    }

  } catch (error) {
    console.error("Image edit error:", error);

    // إعادة النقاط عند فشل التعديل
    if (!isOwner) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE users SET points = points + 3 WHERE telegram_id = ?"
        ).bind(userId),

        env.DB.prepare(`
          INSERT INTO point_transactions
            (telegram_id, amount, reason, created_at)
          VALUES (?, 3, 'إعادة نقاط بسبب فشل التعديل', ?)
        `).bind(userId, new Date().toISOString())
      ]);
    }

    await send(
      env,
      chatId,
      "تعذر تعديل الصورة هذه المرة. أُعيدت نقاطك إن تم خصمها. حاول بصورة أخرى."
    );
  }
}

async function adminCommand(env, chatId, text) {
  const parts = text.split(/\s+/);
  const adding = parts[0] === "/addpoints";
  const target = Number(parts[1]);
  const amount = Number(parts[2]);

  if (
    !Number.isSafeInteger(target) ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 100000
  ) {
    await send(env, chatId,
      "الصيغة:\n/addpoints رقم_المستخدم عدد_النقاط\n/deductpoints رقم_المستخدم عدد_النقاط"
    );
    return;
  }

  const user = await env.DB.prepare(
    "SELECT points FROM users WHERE telegram_id = ?"
  ).bind(target).first();

  if (!user) {
    await send(env, chatId, "المستخدم غير مسجل.");
    return;
  }

  if (!adding && user.points < amount) {
    await send(env, chatId, "رصيد المستخدم غير كافٍ.");
    return;
  }

  const delta = adding ? amount : -amount;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET points = points + ? WHERE telegram_id = ?"
    ).bind(delta, target),

    env.DB.prepare(`
      INSERT INTO point_transactions
        (telegram_id, amount, reason, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(
      target,
      delta,
      adding ? "إضافة يدوية من المالك" : "خصم يدوي من المالك",
      now
    )
  ]);

  await send(env, chatId, "تم تنفيذ العملية بنجاح.");
}

async function handleMessage(message, env) {
  if (!message.from || !message.chat || message.chat.type !== "private") {
    return;
  }

  const userId = message.from.id;
  const chatId = message.chat.id;
  const rawText = message.text || "";
  let text = rawText.trim();

  await ensureTables(env);

  if (text.startsWith("/start")) {
    const payload = text.split(/\s+/)[1] || "";
    const referrerId = payload.startsWith("ref_")
      ? Number(payload.slice(4))
      : null;

    await registerUser(env, message.from, referrerId);
    await send(env, chatId, "أهلاً بك في عالم الخيال ✨", userId === OWNER_ID ? ownerKeyboard() : userKeyboard());
    return;
  }

  await ensureUser(env, message.from);

  if (userId === OWNER_ID && text === "⚙️ لوحة المالك") { await showOwnerPanel(env, chatId); return; }
  if (userId === OWNER_ID && text === "📢 إرسال رسالة للجميع") { await beginAdminAction(env, userId, "broadcast", chatId, "أرسل نص الرسالة التي تريد إرسالها إلى جميع المستخدمين."); return; }
  if (userId === OWNER_ID && text === "📌 تثبيت رسالة للجميع") { await beginAdminAction(env, userId, "pin_broadcast", chatId, "أرسل نص الرسالة التي تريد إرسالها وتثبيتها في محادثة كل مستخدم."); return; }
  if (userId === OWNER_ID && text === "📍 إلغاء تثبيت الرسائل للجميع") { await unpinForAllUsers(env, chatId); return; }
  if (userId === OWNER_ID && text === "➕ إضافة نقاط للمستخدم") { await beginAdminAction(env, userId, "addpoints", chatId, "أرسل معرف المستخدم ثم عدد النقاط، مثال: 123456789 10"); return; }
  if (userId === OWNER_ID && text === "➖ خصم نقاط من المستخدم") { await beginAdminAction(env, userId, "deductpoints", chatId, "أرسل معرف المستخدم ثم عدد النقاط، مثال: 123456789 10"); return; }
  if (userId === OWNER_ID && text && !text.startsWith("/") &&
      !["🖼 تعديل صورة", "🎁 المكافأة اليومية", "💰 رصيدي", "🔗 رابط الدعوة"].includes(text)) {
    if (await finishAdminAction(env, userId, chatId, text)) return;
  }
  if (text === "🖼 تعديل صورة") {
    await env.DB.prepare("DELETE FROM pending_modes WHERE telegram_id = ?").bind(userId).run();
    await send(env, chatId, "أرسل الصورة التي تريد تعديلها مع وصف التعديل أو أرسل الوصف بعدها.", userId === OWNER_ID ? ownerKeyboard() : userKeyboard()); return;
  }

  if (text === "👗 تبديل الملابس") {
    await env.DB.prepare(`
      INSERT INTO pending_modes (telegram_id, mode, created_at)
      VALUES (?, 'clothes_swap', ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        mode = excluded.mode,
        created_at = excluded.created_at
    `).bind(userId, new Date().toISOString()).run();
    await send(env, chatId,
      "👗 تبديل الملابس بالذكاء الاصطناعي\nأرسل صورتك، ثم اكتب وصف الملابس التي تريد ارتداءها. يمكنك أيضاً إرسال الصورة مع الوصف في رسالة واحدة.",
      userId === OWNER_ID ? ownerKeyboard() : userKeyboard()
    );
    return;
  }
  if (text === "🎁 المكافأة اليومية") text = "/daily";
  if (text === "💰 رصيدي") text = "/balance";
  if (text === "🔗 رابط الدعوة") text = "/invite";

  if (text === "/daily") {
    if (userId === OWNER_ID) return;
    const result = await claimDaily(env, userId);

    if (!result.claimed) {
      await send(env, chatId,
        `أخذت مكافأتك اليوم بالفعل.\nرصيدك: ${result.balance} نقطة.`
      );
    } else {
      await send(env, chatId,
        `🎁 حصلت على 3 نقاط.\n` +
        `أيام الاستمرار: ${result.streak}\n` +
        (result.bonus ? "🏆 مكافأة إضافية: 10 نقاط!\n" : "") +
        `رصيدك: ${result.balance} نقطة.`
      );
    }
    return;
  }

  if (text === "/balance") {
    if (userId === OWNER_ID) return;
    const user = await env.DB.prepare(
      "SELECT points FROM users WHERE telegram_id = ?"
    ).bind(userId).first();

    await send(env, chatId, `رصيدك: ${user?.points || 0} نقطة.`);
    return;
  }

  if (text === "/invite") {
    if (userId === OWNER_ID) return;
    const me = await telegram(env, "getMe", {});
    const link = `https://t.me/${me.result.username}?start=ref_${userId}`;

    await send(env, chatId,
      `رابط دعوتك:\n${link}\nتحصل على 5 نقاط عن كل صديق جديد.`
    );
    return;
  }

  if (text === "/admin") {
    if (userId !== OWNER_ID) return;
    await showOwnerPanel(env, chatId);
    return;
  }

  if (text.startsWith("/addpoints") || text.startsWith("/deductpoints")) {
    if (userId !== OWNER_ID) return;
    await adminCommand(env, chatId, text);
    return;
  }

  const documentIsImage = message.document && (
    (message.document.mime_type || "").toLowerCase().startsWith("image/") ||
    /\\.(avif|bmp|gif|heic|heif|jfif|jpeg|jpg|png|tif|tiff|webp|svg)$/i.test(message.document.file_name || "")
  );

  if (message.photo || documentIsImage) {
    const mediaType = message.photo ? "photo" : "image_document";
    const fileId = await archiveMedia(env, message, mediaType);

    if (!fileId) {
      await send(env, chatId, "تعذر حفظ الصورة.");
      return;
    }

    const caption = message.caption || "";
    const selectedMode = await env.DB.prepare(
      "SELECT mode FROM pending_modes WHERE telegram_id = ?"
    ).bind(userId).first();
    const mode = selectedMode?.mode || "normal";

    if (caption.length > 0) {
      await env.DB.prepare("DELETE FROM pending_modes WHERE telegram_id = ?").bind(userId).run();
      await editImage(env, chatId, userId, fileId, caption, mode);
    } else {
      await env.DB.prepare(`
        INSERT INTO pending_edits (telegram_id, file_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET
          file_id = excluded.file_id,
          created_at = excluded.created_at
      `).bind(userId, fileId, new Date().toISOString()).run();

      await send(env, chatId,
        mode === "clothes_swap"
          ? "اكتب وصف الملابس التي تريد تبديلها في الصورة."
          : "أرسل وصف التعديل الذي تريده على الصورة."
      );
    }
    return;
  }

  if (message.video) {
    await archiveMedia(env, message, "video");
    await send(env, chatId,
      "وصل الفيديو وتم حفظه في الأرشيف. تعديل الفيديو بالذكاء الاصطناعي غير متاح في النسخة المجانية حالياً."
    );
    return;
  }

  if (rawText.length > 0 && !rawText.trimStart().startsWith("/")) {
    const pending = await env.DB.prepare(
      "SELECT file_id FROM pending_edits WHERE telegram_id = ?"
    ).bind(userId).first();

    if (pending) {
      await env.DB.prepare(
        "DELETE FROM pending_edits WHERE telegram_id = ?"
      ).bind(userId).run();

      const selectedMode = await env.DB.prepare(
        "SELECT mode FROM pending_modes WHERE telegram_id = ?"
      ).bind(userId).first();
      const mode = selectedMode?.mode || "normal";
      await env.DB.prepare("DELETE FROM pending_modes WHERE telegram_id = ?").bind(userId).run();

      await editImage(env, chatId, userId, pending.file_id, rawText, mode);
      return;
    }
  }

  if (text === "/help") {
    await send(env, chatId,
      "أرسل صورة ثم اكتب وصف التعديل.\n" +
      "يمكنك أيضاً إرسال الصورة مع وصف في التعليق.\n" +
      "/daily للمكافأة اليومية\n" +
      "/balance لمعرفة رصيدك\n" +
      "/invite لدعوة الأصدقاء"
    );
  }
}
