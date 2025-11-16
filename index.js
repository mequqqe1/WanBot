const { Telegraf, Markup } = require('telegraf');

// ==== НАСТРОЙКИ ====
const BOT_TOKEN = '8049050039:AAFUvD0SsVr26_pR06imGPmL8toh_7N5e_I';

// ID канала/чата, куда будут прилетать анкеты (типичный вид: -1001234567890)
const REVIEW_CHAT_ID = -5024825539;

// Ссылка-приглашение в чат, куда добавляем принятых
const INVITE_LINK = 'https://t.me/freedommakerschat';

// ===================

const bot = new Telegraf(BOT_TOKEN);

// Храним состояния пользователей в памяти
// userStates[userId] = { step: 'age' | 'name' | 'city' | 'done', data: { age, name, city } }
const userStates = {};

// ==== АНТИСПАМ ====

// трекаем активность по пользователям
const spamTracker = {};
const SPAM_LIMIT = 8;          // сколько сообщений за окно
const SPAM_WINDOW_MS = 10_000; // окно в мс (10 секунд)
const MUTE_MS = 60_000;        // тайм-аут (1 минута)

/**
 * Возвращает true, если юзера надо игнорить (спамит).
 * Иначе false — можно продолжать обработку.
 */
function isSpam(ctx) {
  // работаем только с личками, в других чатах мы и так почти молчим
  if (!ctx.from || ctx.chat.type !== 'private') return false;

  const userId = ctx.from.id;
  const now = Date.now();

  if (!spamTracker[userId]) {
    spamTracker[userId] = {
      windowStart: now,
      count: 0,
      mutedUntil: 0,
      warned: false,
    };
  }

  const info = spamTracker[userId];

  // если юзер в муте
  if (now < info.mutedUntil) {
    // чтобы не спамить предупреждениями — просто игнорим
    return true;
  }

  // если окно давно прошло — обнуляем
  if (now - info.windowStart > SPAM_WINDOW_MS) {
    info.windowStart = now;
    info.count = 0;
    info.warned = false;
  }

  info.count++;

  // если превысил лимит — мьютим
  if (info.count > SPAM_LIMIT) {
    info.mutedUntil = now + MUTE_MS;

    if (!info.warned) {
      info.warned = true;
      ctx.reply('Не спамь чел');
    }

    return true;
  }

  return false;
}

// ===================

// Команда /start — запускаем анкетирование (Только в ЛИЧКЕ!)
bot.start((ctx) => {
  if (ctx.chat.type !== 'private') return;

  if (isSpam(ctx)) return;

  const userId = ctx.from.id;

  userStates[userId] = {
    step: 'age',
    data: {}
  };

  ctx.reply('Привет! Давай заполним анкету 😊\nСначала скажи, пожалуйста, свой возраст:');
});

// Команда /chatid — оставим только для лички
bot.command('chatid', (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (isSpam(ctx)) return;

  ctx.reply(`ID этого чата: ${ctx.chat.id}`);
});

// Обработка любого текста (по шагам анкеты) — ТОЛЬКО ЛИЧКА
bot.on('text', async (ctx) => {
  if (ctx.chat.type !== 'private') return;

  if (isSpam(ctx)) return;

  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  const state = userStates[userId];

  // Если пользователь не в процессе анкеты — просим нажать /start
  if (!state) {
    await ctx.reply('Чтобы заполнить анкету, нажми /start');
    return;
  }

  if (state.step === 'age') {
    const ageNum = parseInt(text, 10);
    if (isNaN(ageNum) || ageNum <= 0 || ageNum > 120) {
      await ctx.reply('Похоже, это не очень похоже на возраст 🙈\nНапиши, пожалуйста, настоящий возраст цифрами:');
      return;
    }

    state.data.age = ageNum;
    state.step = 'name';
    await ctx.reply('Ок, спасибо! Теперь напиши, пожалуйста, своё имя:');
    return;
  }

  if (state.step === 'name') {
    state.data.name = text;
    state.step = 'city';
    await ctx.reply('Отлично! Теперь напиши, пожалуйста, свой город:');
    return;
  }

  if (state.step === 'city') {
    state.data.city = text;
    state.step = 'done';

    // Формируем анкету
    const { age, name } = state.data;
    const city = text;

    const from = ctx.from;
    const userId = from.id;
    const username = from.username ? '@' + from.username : null;

    let userLine = '';
    if (username) {
      userLine = `Юзер: ${username} (ID: ${userId})`;
    } else {
      userLine = `Юзер: (без username) ID: ${userId}`;
    }

    const profileText = [
      '📝 Новая анкета:',
      '',
      `Возраст: ${age}`,
      `Имя: ${name}`,
      `Город: ${city}`,
      userLine
    ].join('\n');

    // Отправляем в канал модерации с кнопками Принять / Отказать
    try {
      await ctx.telegram.sendMessage(
        REVIEW_CHAT_ID,
        profileText,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Принять', callback_data: `approve:${userId}` },
                { text: '❌ Отказать', callback_data: `reject:${userId}` }
              ]
            ]
          }
        }
      );
    } catch (err) {
      console.error('Ошибка отправки анкеты в канал:', err);
      await ctx.reply('Произошла ошибка при отправке анкеты на модерацию. Попробуй позже.');
      return;
    }

    await ctx.reply('Спасибо! Твоя анкета отправлена на модерацию ✅');

    delete userStates[userId];
    return;
  }
});

// Обработка нажатий по кнопкам "Принять" / "Отказать"
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (!data) {
    return ctx.answerCbQuery();
  }

  const [action, userIdStr] = data.split(':');
  const targetUserId = Number(userIdStr);

  if (!targetUserId) {
    await ctx.answerCbQuery('Ошибка: не найден ID пользователя');
    return;
  }

  if (action === 'approve') {
    await ctx.answerCbQuery('Анкета принята ✅');

    try {
      await ctx.editMessageReplyMarkup();
    } catch (e) {}

    // Отправляем пользователю приглашение в чат + правила
    try {
      await ctx.telegram.sendMessage(
        targetUserId,
        `Твоя анкета одобрена 🎉

Вот приглашение в чат:
${INVITE_LINK}

Перед вступлением, пожалуйста, ознакомься с правилами и важной информацией:

📌 Правила чата:
https://graph.org/Pravila-chata-07-28-89

📌 Правила поведения на встречах:
https://graph.org/Pravila-povedeniya-na-vstrechah-07-28

📌 Доп. правила на алко-встречах:
https://graph.org/Dop-pravila-k-alko-vstrecham-07-28-2

📌 Важная информация для участников:
https://graph.org/Vazhnaya-informaciya-dlya-uchastnikov-07-28-4

Ждём тебя ❤️`
      );
    } catch (err) {
      console.error('Ошибка отправки приглашения пользователю:', err);
    }

  } else if (action === 'reject') {
    await ctx.answerCbQuery('Анкета отклонена ❌');

    try {
      await ctx.editMessageReplyMarkup();
    } catch (e) {}
  } else {
    await ctx.answerCbQuery();
  }
});

// Логируем только личку, чтобы не спамить консоль из групп/каналов
bot.on('message', (ctx) => {
  if (ctx.chat.type === 'private') {
    console.log(ctx.chat);
  }
});

// Запуск бота
bot.launch()
  .then(() => console.log('Бот запущен'))
  .catch(console.error);

// Корректная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
