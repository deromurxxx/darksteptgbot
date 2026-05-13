import express from 'express';
import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  collection, 
  getDocs, 
  addDoc, 
  updateDoc,
  deleteDoc,
  query, 
  where, 
  doc, 
  getDoc, 
  setDoc,
  limit,
  orderBy,
  serverTimestamp 
} from 'firebase/firestore';
import { db } from './src/firebase.ts';

import { GoogleGenAI } from "@google/genai";

dotenv.config();

let ai = new GoogleGenAI({ apiKey: process.env.MY_GEMINI_KEY || '' });

// Функция для обновления ключа ИИ
const refreshAIKey = async () => {
  try {
    const settingsDoc = await getDoc(doc(db, 'settings', 'gemini'));
    if (settingsDoc.exists()) {
      const key = settingsDoc.data().apiKey;
      if (key) {
        ai = new GoogleGenAI({ apiKey: key });
        console.log('✅ AI ключ успешно загружен из базы данных');
      }
    }
  } catch (e) {
    console.error('Ошибка загрузки ключа из БД:', e);
  }
};

// Пробуем загрузить ключ при старте
refreshAIKey();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('КРИТИЧЕСКАЯ ОШИБКА: TELEGRAM_BOT_TOKEN не определен!');
}

const bot = new Telegraf(token || '');

// --- Константы ---
const ADMIN_IDS = [5355508045, 1728243133];
const CATEGORIES = [
  'шорты', 'кофти', 'штани', 'взуття', 
  'головні убори', 'ремні', 'аксесуари', 
  'куртки', 'футболки', 'костюми', 'сумки'
];

const LOCATIONS = {
  LOCAL: 'local',
  CHINA: 'china'
};

// Кэш для сбора альбомов (media_group)
const mediaGroupCache: Record<string, { 
  photos: string[], 
  text: string, 
  timer: NodeJS.Timeout | null 
}> = {};

// Кэш для удаления старых сообщений при навигации
const userMessageLogs: Record<number, number[]> = {};

// Кэш для навигации по предложениям ИИ
const aiResultsCache: Record<number, string[]> = {};

const clearUserMessages = async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId || !userMessageLogs[userId]) return;
  for (const msgId of userMessageLogs[userId]) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, msgId);
    } catch (e) {
      // Игнорируем ошибки (сообщение уже удалено или слишком старое)
    }
  }
  userMessageLogs[userId] = [];
  // Небольшая пауза после удаления, чтобы Telegram успел отработать анимацию
  await new Promise(res => setTimeout(res, 400));
};

// --- Состояния для админки ---
const adminState: Record<number, { 
  step: string; 
  data: Partial<Product>;
  editId?: string;
  importQueue?: Array<Partial<Product>>;
}> = {};

// --- Types ---
interface Product {
  id?: string;
  name: string;
  description: string;
  price: number;
  category: string;
  location: string; // 'local' or 'china'
  photoId?: string; // Основное фото
  photoIds?: string[]; // Все фото из альбома
  createdAt: any;
}

// --- Middleware & Helpers ---
const isAdmin = (ctx: Context): boolean => {
  return ADMIN_IDS.includes(ctx.from?.id || 0);
};

const formatProductHTML = (p: Product) => {
  const locEmoji = p.location === 'china' ? '🇨🇳' : '🛍';
  const locText = p.location === 'china' ? 'ИЗ КИТАЯ' : 'В НАЛИЧИИ';
  
  return `✨ <b>${p.name.toUpperCase()}</b> ✨\n\n` +
         `${locEmoji} <b>ЛОКАЦИЯ:</b> ${locText}\n` +
         `💰 <b>ЦЕНА:</b> ${p.price} грн\n` +
         `📁 <b>КАТЕГОРИЯ:</b> #${p.category.replace(/\s+/g, '_')}\n\n` +
         `📝 <b>ОПИСАНИЕ:</b>\n${p.description}\n\n` +
         `🚀 <b>DARKSTEP — ТВОЙ СТИЛЬ ЗДЕСЬ</b>`;
};

const chunkArray = <T>(array: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

const sendProduct = async (ctx: Context, p: Product, id: string, isAdminMode: boolean = false, nav?: { type: string, query: string, index: number, total: number }) => {
  const userId = ctx.from?.id;
  const keyboard = [
    [Markup.button.callback('🛒 Купить', `buy_${id}`)]
  ];

  if (nav && nav.total > 1) {
    const navRow = [];
    if (nav.index > 0) {
      navRow.push(Markup.button.callback('⬅️ Назад', `nav_${nav.type}_${nav.query}_${nav.index - 1}`));
    }
    navRow.push(Markup.button.callback(`${nav.index + 1} / ${nav.total}`, 'noop'));
    if (nav.index < nav.total - 1) {
      navRow.push(Markup.button.callback('Вперед ➡️', `nav_${nav.type}_${nav.query}_${nav.index + 1}`));
    }
    keyboard.push(navRow);
  }

  if (isAdminMode) {
    keyboard.push([
      Markup.button.callback('📝 Ред.', `edit_${id}`),
      Markup.button.callback('🗑 Удал.', `del_${id}`)
    ]);
  }

  const caption = formatProductHTML(p);
  const inlineKeyboard = Markup.inlineKeyboard(keyboard);
  const sentIds: number[] = [];

  try {
    if (p.photoIds && p.photoIds.length > 1) {
      const media = p.photoIds.map((photoId, index) => ({
        type: 'photo',
        media: photoId,
        caption: index === 0 ? caption : '',
        parse_mode: 'HTML'
      }));
      
      const mediaMsgs = await ctx.replyWithMediaGroup(media as any);
      mediaMsgs.forEach(m => sentIds.push(m.message_id));
      
      const controlMsg = await ctx.reply(
        '➖➖➖➖➖➖➖➖➖➖➖➖', 
        { 
          parse_mode: 'HTML',
          ...inlineKeyboard 
        }
      );
      sentIds.push(controlMsg.message_id);
    } else if (p.photoId) {
      const msg = await ctx.replyWithPhoto(p.photoId, {
        caption: caption,
        parse_mode: 'HTML',
        ...inlineKeyboard
      });
      sentIds.push(msg.message_id);
    } else {
      const msg = await ctx.reply(caption, {
        parse_mode: 'HTML',
        ...inlineKeyboard
      });
      sentIds.push(msg.message_id);
    }

    if (userId) {
      userMessageLogs[userId] = sentIds;
    }
  } catch (e) {
    console.error('Ошибка при отправке товара:', e);
  }
};

// Парсер текста из канала
const parseProductText = (text: string) => {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Очистка названия от лишних эмодзи в начале
  let name = lines[0] || 'БЕЗ НАЗВАНИЯ';
  name = name.replace(/^[\u{1F300}-\u{1F9FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2300}-\u{23FF}]/gu, '').trim();
  
  // Функция для очистки цены от эмодзи-цифр и пробелов
  const extractDigits = (str: string) => {
    // Заменяем эмодзи-цифры (0️⃣-9️⃣) на обычные
    const emojiDigits: Record<string, string> = {
      '0️⃣': '0', '1️⃣': '1', '2️⃣': '2', '3️⃣': '3', '4️⃣': '4',
      '5️⃣': '5', '6️⃣': '6', '7️⃣': '7', '8️⃣': '8', '9️⃣': '9'
    };
    let res = str;
    for (const [emoji, digit] of Object.entries(emojiDigits)) {
      res = res.split(emoji).join(digit);
    }
    return res.replace(/\D/g, '');
  };

  // Улучшенный поиск цены
  const priceRegex = /(?:Ціна|Цена|Price|💰|💸)\s*[:\-\s]*([\d\s0-9️⃣]+)/i;
  const currencyRegex = /([\d\s0-9️⃣]+)\s*(?:грн|uah|руб|usd|\$|eur)/i;
  
  const priceMatch = text.match(priceRegex) || text.match(currencyRegex);
  const price = priceMatch ? parseFloat(extractDigits(priceMatch[1])) : 0;
  
  // Фильтрация описания (оставляем только Размер, Качество, Доставку)
  const description = lines.filter(line => 
    line.includes('Розмір') || 
    line.includes('Якість') || 
    line.includes('Доставка') ||
    line.includes('Размер') || 
    line.includes('Качество')
  ).join('\n') || 'Описание отсутствует';
  
  // Попытка угадать категорию
  let category = CATEGORIES[0];
  const lowerText = text.toLowerCase();
  for (const cat of CATEGORIES) {
    if (lowerText.includes(cat.toLowerCase().slice(0, -1))) {
      category = cat;
      break;
    }
  }
  
  return { name, price, description, category };
};

// --- Bot Logic ---

// Авто-синхронизация из канала
bot.on('channel_post', async (ctx) => {
  try {
    const post = ctx.channelPost as any;
    const mediaGroupId = post.media_group_id;
    const text = post.text || post.caption;
    const photoId = post.photo ? post.photo.pop().file_id : null;

    if (mediaGroupId) {
      if (!mediaGroupCache[mediaGroupId]) {
        mediaGroupCache[mediaGroupId] = { photos: [], text: '', timer: null };
      }
      if (photoId) mediaGroupCache[mediaGroupId].photos.push(photoId);
      if (text) mediaGroupCache[mediaGroupId].text = text;

      if (mediaGroupCache[mediaGroupId].timer) clearTimeout(mediaGroupCache[mediaGroupId].timer);
      
      mediaGroupCache[mediaGroupId].timer = setTimeout(async () => {
        const data = mediaGroupCache[mediaGroupId];
        const parsed = parseProductText(data.text || '');
        await addDoc(collection(db, 'products'), {
          ...parsed,
          photoId: data.photos[0] || null,
          photoIds: data.photos,
          createdAt: serverTimestamp()
        });
        console.log(`✅ Авто-импорт альбома: ${parsed.name}`);
        delete mediaGroupCache[mediaGroupId];
      }, 3000);
      return;
    }

    if (!text) return;
    const parsed = parseProductText(text);
    await addDoc(collection(db, 'products'), {
      ...parsed,
      photoId,
      photoIds: photoId ? [photoId] : [],
      createdAt: serverTimestamp()
    });
    console.log(`✅ Авто-импорт поста: ${parsed.name}`);
  } catch (e) {
    console.error('Ошибка авто-импорта из канала:', e);
  }
});

// Главное меню
const showMainMenu = (ctx: Context) => {
  const buttons = [
    ['🛍 В НАЛИЧИИ', '🇨🇳 КИТАЙ'],
    ['🔍 ПОИСК', '🤖 ИИ-ПОМОЩНИК']
  ];
  
  if (isAdmin(ctx)) {
    buttons.push(['🛠 АДМИН-ПАНЕЛЬ']);
  }
  
  return ctx.reply('👋 <b>ДОБРО ПОЖАЛОВАТЬ В DARKSTEP!</b> 👟\n\nВыбери нужный раздел в меню ниже:', 
    {
      parse_mode: 'HTML',
      ...Markup.keyboard(buttons).resize()
    }
  );
};

const finishProductProcess = async (ctx: Context) => {
  const userId = ctx.from!.id;
  const state = adminState[userId];
  try {
    console.log('Попытка сохранения товара:', state.data);
    if (state.editId) {
      const docRef = doc(db, 'products', state.editId);
      await updateDoc(docRef, {
        ...state.data,
        updatedAt: serverTimestamp()
      });
      await ctx.reply('✅ <b>ТОВАР УСПЕШНО ОБНОВЛЕН!</b>', { parse_mode: 'HTML' });
    } else {
      await saveProduct(state.data as Product);
      await ctx.reply('✅ <b>ТОВАР УСПЕШНО ДОБАВЛЕН В КАТАЛОГ!</b>', { parse_mode: 'HTML' });
    }
  } catch (e: any) {
    console.error('КРИТИЧЕСКАЯ ОШИБКА СОХРАНЕНИЯ:', e);
    await ctx.reply(`❌ <b>ОШИБКА ПРИ СОХРАНЕНИИ!</b>\n\nДетали: ${e.message || 'Неизвестная ошибка'}`, { parse_mode: 'HTML' });
  }
  delete adminState[userId];
  return showMainMenu(ctx);
};

const saveProduct = async (data: Product) => {
  try {
    console.log('Сохранение товара в БД:', data.name, 'Локация:', data.location);
    const docRef = await addDoc(collection(db, 'products'), {
      ...data,
      createdAt: serverTimestamp()
    });
    console.log('Товар сохранен с ID:', docRef.id);
    return true;
  } catch (e) {
    console.error('Ошибка сохранения товара:', e);
    return false;
  }
};

const processNextInQueue = async (ctx: Context) => {
  const userId = ctx.from!.id;
  const state = adminState[userId];
  
  if (!state || !state.importQueue || state.importQueue.length === 0) {
    delete adminState[userId];
    await ctx.reply('✅ <b>ВСЕ ТОВАРЫ УСПЕШНО ИМПОРТИРОВАНЫ!</b>', { parse_mode: 'HTML' });
    return showMainMenu(ctx);
  }

  const nextProduct = state.importQueue[0];
  state.data = nextProduct;
  state.step = 'CONFIRM_IMPORT';

  const queueInfo = state.importQueue.length > 1 ? `\n\n<i>(Осталось в очереди: ${state.importQueue.length - 1})</i>` : '';

  return ctx.reply(
    `📥 <b>ИМПОРТ ТОВАРА (${state.importQueue.length} в очереди)</b>\n\n` +
    `📦 <b>Название:</b> ${nextProduct.name}\n` +
    `💰 <b>Цена:</b> ${nextProduct.price} грн\n\n` +
    `<i>Выберите локацию для этого товара:</i>${queueInfo}`,
    {
      parse_mode: 'HTML',
      ...Markup.keyboard([
        ['🛍 В НАЛИЧИИ', '🇨🇳 КИТАЙ'],
        ['❌ ОТМЕНА']
      ]).resize()
    }
  );
};

// --- Админ-обработчики (в начале для приоритета) ---

bot.on(message('photo'), async (ctx, next) => {
  const userId = ctx.from!.id;
  const msg = ctx.message as any;
  const mediaGroupId = msg.media_group_id;

  // Умный импорт через пересылку альбомов
  if (isAdmin(ctx) && msg.forward_from_chat) {
    if (mediaGroupId) {
      if (!mediaGroupCache[mediaGroupId]) {
        mediaGroupCache[mediaGroupId] = { photos: [], text: '', timer: null };
      }
      const photoId = msg.photo.pop().file_id;
      mediaGroupCache[mediaGroupId].photos.push(photoId);
      if (msg.caption) mediaGroupCache[mediaGroupId].text = msg.caption;

      if (mediaGroupCache[mediaGroupId].timer) clearTimeout(mediaGroupCache[mediaGroupId].timer);
      
      mediaGroupCache[mediaGroupId].timer = setTimeout(async () => {
        const data = mediaGroupCache[mediaGroupId];
        const parsed = parseProductText(data.text || '');
        
        if (!adminState[userId]) adminState[userId] = { step: 'IDLE', data: {}, importQueue: [] };
        if (!adminState[userId].importQueue) adminState[userId].importQueue = [];
        
        adminState[userId].importQueue!.push({
          ...parsed,
          photoId: data.photos[0] || null,
          photoIds: data.photos
        });

        if (adminState[userId].step !== 'CONFIRM_IMPORT') {
          await processNextInQueue(ctx);
        }
        delete mediaGroupCache[mediaGroupId];
      }, 2000);
      return;
    } else {
      // Одиночное фото
      const parsed = parseProductText(msg.caption || '');
      const photoId = msg.photo.pop().file_id;
      
      if (!adminState[userId]) adminState[userId] = { step: 'IDLE', data: {}, importQueue: [] };
      if (!adminState[userId].importQueue) adminState[userId].importQueue = [];
      
      adminState[userId].importQueue!.push({
        ...parsed,
        photoId: photoId,
        photoIds: [photoId]
      });

      if (adminState[userId].step !== 'CONFIRM_IMPORT') {
        return processNextInQueue(ctx);
      }
      return;
    }
  }

  // Обычная загрузка фото при добавлении товара вручную
  if (adminState[userId] && adminState[userId].step === 'WAIT_PHOTO') {
    const photoId = msg.photo.pop().file_id;
    if (!adminState[userId].data.photoIds) adminState[userId].data.photoIds = [];
    adminState[userId].data.photoIds.push(photoId);
    if (!adminState[userId].data.photoId) adminState[userId].data.photoId = photoId;
    
    return ctx.reply('✅ Фото добавлено! Можете отправить еще или нажмите /skip для завершения.', {
      ...Markup.keyboard([['/skip', '❌ ОТМЕНА']]).resize()
    });
  }

  return next();
});

bot.on(message('text'), async (ctx, next) => {
  const text = ctx.message.text;
  const userId = ctx.from!.id;
  const msg = ctx.message as any;

  // Умный импорт текста без фото
  if (isAdmin(ctx) && msg.forward_from_chat && (!adminState[userId] || !adminState[userId].step.startsWith('WAIT_'))) {
    const parsed = parseProductText(text);
    
    if (!adminState[userId]) adminState[userId] = { step: 'IDLE', data: {}, importQueue: [] };
    if (!adminState[userId].importQueue) adminState[userId].importQueue = [];
    
    adminState[userId].importQueue!.push(parsed);
    
    if (adminState[userId].step !== 'CONFIRM_IMPORT') {
      return processNextInQueue(ctx);
    }
    return;
  }

  if (text === '❌ ОТМЕНА') {
    delete adminState[userId];
    return showMainMenu(ctx);
  }

  // Если админ в процессе добавления/редактирования
  if (adminState[userId]) {
    const state = adminState[userId];
    
    // Обработка шага подтверждения импорта
    if (state.step === 'CONFIRM_IMPORT') {
      if (text === '🛍 В НАЛИЧИИ') {
        state.data.location = LOCATIONS.LOCAL;
        return ctx.reply('📂 <b>ВЫБЕРИТЕ КАТЕГОРИЮ:</b>', {
          parse_mode: 'HTML',
          ...Markup.keyboard([
            ...chunkArray(CATEGORIES, 2),
            ['❌ ОТМЕНА']
          ]).resize()
        });
      }
      
      if (text === '🇨🇳 КИТАЙ') {
        state.data.location = LOCATIONS.CHINA;
        return ctx.reply('📂 <b>ВЫБЕРИТЕ КАТЕГОРИЮ:</b>', {
          parse_mode: 'HTML',
          ...Markup.keyboard([
            ...chunkArray(CATEGORIES, 2),
            ['❌ ОТМЕНА']
          ]).resize()
        });
      }

      if (CATEGORIES.includes(text)) {
        state.data.category = text;
        
        // Если локация не выбрана (старый код или ошибка), ставим по умолчанию LOCAL
        if (!state.data.location) state.data.location = LOCATIONS.LOCAL;

        // Сохраняем текущий товар
        await saveProduct(state.data as Product);
        
        // Удаляем его из очереди
        if (state.importQueue) {
          state.importQueue.shift();
          return processNextInQueue(ctx);
        } else {
          delete adminState[userId];
          await ctx.reply('✅ <b>ТОВАР УСПЕШНО ДОБАВЛЕН!</b>', { parse_mode: 'HTML' });
          return showMainMenu(ctx);
        }
      }
    }
    
    switch (state.step) {
      case 'WAIT_NAME':
        state.data.name = text;
        state.step = 'WAIT_LOCATION';
        return ctx.reply('📍 <b>ВЫБЕРИТЕ ЛОКАЦИЮ ТОВАРА:</b>', {
          parse_mode: 'HTML',
          ...Markup.keyboard([
            ['🛍 В НАЛИЧИИ', '🇨🇳 КИТАЙ'],
            ['❌ ОТМЕНА']
          ]).resize()
        });

      case 'WAIT_LOCATION':
        if (text === '🛍 В НАЛИЧИИ') state.data.location = LOCATIONS.LOCAL;
        else if (text === '🇨🇳 КИТАЙ') state.data.location = LOCATIONS.CHINA;
        else return ctx.reply('⚠️ Пожалуйста, выберите локацию из меню!');
        
        state.step = 'WAIT_PRICE';
        return ctx.reply('💰 <b>ВВЕДИТЕ ЦЕНУ (только цифры):</b>', {
          parse_mode: 'HTML',
          ...Markup.keyboard([['❌ ОТМЕНА']]).resize()
        });

      case 'WAIT_PRICE':
        const price = parseFloat(text.replace(/\D/g, ''));
        if (isNaN(price)) return ctx.reply('⚠️ Введите корректное число!');
        state.data.price = price;
        state.step = 'WAIT_CATEGORY';
        return ctx.reply('📂 <b>ВЫБЕРИТЕ КАТЕГОРИЮ:</b>', {
          parse_mode: 'HTML',
          ...Markup.keyboard([
            ...chunkArray(CATEGORIES, 2),
            ['❌ ОТМЕНА']
          ]).resize()
        });

      case 'WAIT_CATEGORY':
        if (!CATEGORIES.includes(text)) return ctx.reply('⚠️ Выберите категорию из списка!');
        state.data.category = text;
        state.step = 'WAIT_DESC';
        return ctx.reply('📝 <b>ВВЕДИТЕ ОПИСАНИЕ ТОВАРА:</b>', {
          parse_mode: 'HTML',
          ...Markup.keyboard([['❌ ОТМЕНА']]).resize()
        });

      case 'WAIT_DESC':
        state.data.description = text;
        state.step = 'WAIT_PHOTO';
        return ctx.reply('📸 <b>ОТПРАВЬТЕ ФОТО ТОВАРА:</b>\n\nВы можете отправить одно фото или несколько (альбомом). Когда закончите, нажмите /skip', {
          parse_mode: 'HTML',
          ...Markup.keyboard([['/skip', '❌ ОТМЕНА']]).resize()
        });

      case 'WAIT_BROADCAST':
        state.data.description = text;
        state.step = 'CONFIRM_BROADCAST';
        return ctx.reply(`📢 <b>ПОДТВЕРДИТЕ РАССЫЛКУ:</b>\n\n${text}`, {
          parse_mode: 'HTML',
          ...Markup.keyboard([['✅ ОТПРАВИТЬ', '❌ ОТМЕНА']]).resize()
        });

      case 'CONFIRM_BROADCAST':
        if (text === '✅ ОТПРАВИТЬ') {
          const messageText = state.data.description;
          const usersSnap = await getDocs(collection(db, 'users'));
          let count = 0;
          for (const userDoc of usersSnap.docs) {
            try {
              await ctx.telegram.sendMessage(userDoc.id, messageText!, { parse_mode: 'HTML' });
              count++;
            } catch (e) {
              console.error(`Ошибка рассылки пользователю ${userDoc.id}:`, e);
            }
          }
          await ctx.reply(`✅ Рассылка завершена! Отправлено ${count} пользователям.`);
          delete adminState[userId];
          return showMainMenu(ctx);
        }
        break;
    }
    return; // Если мы в процессе админки, не пускаем дальше
  }

  return next();
});

bot.start(async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) {
    try {
      await setDoc(doc(db, 'users', userId.toString()), {
        id: userId,
        username: ctx.from?.username || '',
        firstName: ctx.from?.first_name || '',
        lastSeen: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.error('Ошибка сохранения пользователя:', e);
    }
  }
  return showMainMenu(ctx);
});

// Каталог
bot.hears('🛍 В НАЛИЧИИ', async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && adminState[userId]) return next(); // Пропускаем к обработчику состояний
  
  return ctx.reply('📂 <b>ВЫБЕРИТЕ КАТЕГОРИЮ (В НАЛИЧИИ):</b>', 
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(
        chunkArray(
          CATEGORIES.map(cat => Markup.button.callback(`🔹 ${cat.toUpperCase()}`, `cat_${LOCATIONS.LOCAL}_${cat}`)),
          2
        )
      )
    }
  );
});

bot.hears('🇨🇳 КИТАЙ', async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && adminState[userId]) return next(); // Пропускаем к обработчику состояний

  return ctx.reply('📂 <b>ВЫБЕРИТЕ КАТЕГОРИЮ (ИЗ КИТАЯ):</b>', 
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(
        chunkArray(
          CATEGORIES.map(cat => Markup.button.callback(`🔹 ${cat.toUpperCase()}`, `cat_${LOCATIONS.CHINA}_${cat}`)),
          2
        )
      )
    }
  );
});

// Обработка категорий
bot.action(/^cat_(local|china)_(.+)$/, async (ctx) => {
  const userId = ctx.from?.id;
  if (userId && adminState[userId]) return ctx.answerCbQuery('⚠️ Сначала завершите добавление товара!');
  
  try {
    const location = ctx.match[1];
    const category = ctx.match[2];
    const q = query(
      collection(db, 'products'),
      where('location', '==', location),
      where('category', '==', category),
      orderBy('createdAt', 'desc')
    );
    const productsSnap = await getDocs(q);

    if (productsSnap.empty) {
      await ctx.answerCbQuery();
      const locText = location === 'china' ? 'из Китая' : 'в наличии';
      return ctx.reply(`В категории "<b>${category}</b>" (${locText}) пока нет товаров.`, { parse_mode: 'HTML' });
    }

    await ctx.answerCbQuery();
    await clearUserMessages(ctx);
    const p = productsSnap.docs[0].data() as Product;
    await sendProduct(ctx, p, productsSnap.docs[0].id, false, {
      type: `cat_${location}`,
      query: category,
      index: 0,
      total: productsSnap.docs.length
    });
  } catch (error) {
    console.error('Ошибка каталога:', error);
    ctx.reply('Произошла ошибка при загрузке каталога.');
  }
});

// Универсальный обработчик навигации
bot.action(/^nav_(cat_local|cat_china|manage_local|manage_china|cat|search|manage|ai)_(.+)_(\d+)$/, async (ctx) => {
  try {
    const type = ctx.match[1];
    const queryStr = ctx.match[2];
    const index = parseInt(ctx.match[3]);

    let docs: any[] = [];
    let total = 0;

    if (type === 'ai') {
      const userId = ctx.from?.id;
      const ids = userId ? aiResultsCache[userId] : null;
      if (!ids) return ctx.answerCbQuery('Результаты ИИ устарели');
      
      total = ids.length;
      const productId = ids[index];
      const productDoc = await getDoc(doc(db, 'products', productId));
      if (!productDoc.exists()) return ctx.answerCbQuery('Товар не найден');
      
      await ctx.answerCbQuery();
      await clearUserMessages(ctx);
      const p = productDoc.data() as Product;
      return await sendProduct(ctx, p, productDoc.id, false, {
        type: 'ai',
        query: 'last',
        index: index,
        total: total
      });
    }

    let q;
    if (type.startsWith('cat_') || type.startsWith('manage_') || type === 'cat' || type === 'manage') {
      const isChina = type.includes('_china');
      const location = isChina ? LOCATIONS.CHINA : LOCATIONS.LOCAL;
      const isAdminMode = type.startsWith('manage');

      q = query(
        collection(db, 'products'),
        where('location', '==', location),
        where('category', '==', queryStr),
        orderBy('createdAt', 'desc')
      );
      
      const productsSnap = await getDocs(q);
      docs = productsSnap.docs;
      total = docs.length;

      if (docs.length === 0) return ctx.answerCbQuery('Товары не найдены');
      
      await ctx.answerCbQuery();
      await clearUserMessages(ctx);
      const p = docs[index].data() as Product;
      return await sendProduct(ctx, p, docs[index].id, isAdminMode, {
        type: type,
        query: queryStr,
        index: index,
        total: total
      });
    } else {
      // Для поиска (упрощенно, так как Firestore не поддерживает полнотекстовый поиск с orderBy легко)
      q = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
    }

    const productsSnap = await getDocs(q);
    docs = productsSnap.docs as any[];

    if (type === 'search') {
      docs = docs.filter(d => (d.data() as Product).name.toLowerCase().includes(queryStr.toLowerCase()));
    }

    if (docs.length === 0 || !docs[index]) {
      return ctx.answerCbQuery('Товар не найден');
    }

    await ctx.answerCbQuery();
    await clearUserMessages(ctx);
    
    const p = docs[index].data() as Product;
    await sendProduct(ctx, p, docs[index].id, type === 'manage', {
      type,
      query: queryStr,
      index,
      total: docs.length
    });
  } catch (e) {
    console.error('Ошибка навигации:', e);
    ctx.answerCbQuery('Ошибка навигации');
  }
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// --- ИИ-Помощник ---

bot.hears('🤖 ИИ-ПОМОЩНИК', (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && adminState[userId]) return next();
  ctx.reply(
    '👋 <b>Я твой персональный ИИ-стилист DARKSTEP!</b>\n\n' +
    'Напиши мне, что ты ищешь или какой образ хочешь подобрать. Например:\n' +
    '— <i>"Подбери мне летний образ с шортами"</i>\n' +
    '— <i>"Что у вас есть из обуви на весну?"</i>\n' +
    '— <i>"С чем лучше сочетать черную куртку?"</i>\n\n' +
    'Я проанализирую наш ассортимент и дам рекомендации!',
    { parse_mode: 'HTML' }
  );
});

// Обработка запросов к ИИ
const handleAIStylist = async (ctx: Context, userText: string) => {
  try {
    await ctx.sendChatAction('typing');
    
    // Получаем все товары для контекста ИИ
    const productsSnap = await getDocs(collection(db, 'products'));
    const allProducts = productsSnap.docs.map(d => ({
      id: d.id,
      name: d.data().name,
      category: d.data().category,
      price: d.data().price,
      description: d.data().description
    }));

    const systemPrompt = `Ты — профессиональный ИИ-стилист магазина одежды DARKSTEP. 
Твоя задача: помогать клиентам подбирать образы и товары из нашего ассортимента.
Будь вежливым, стильным и экспертным в моде. Используй эмодзи.

Наш текущий ассортимент:
${JSON.stringify(allProducts.map(p => ({ id: p.id, name: p.name, category: p.category, price: p.price })), null, 2)}

Инструкции:
1. Если клиент просит подобрать образ, сочетай товары из разных категорий.
2. Называй точные названия товаров.
3. ВАЖНО: В конце своего ответа ОБЯЗАТЕЛЬНО добавь список ID упомянутых товаров в формате: [PRODUCT_IDS: id1, id2, ...].
4. Если подходящего товара нет, предложи близкий вариант.
5. Отвечай на языке запроса пользователя.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: userText,
      config: {
        systemInstruction: systemPrompt
      }
    });

    let aiText = response.text || "Извини, я немного задумался. Попробуй еще раз!";
    
    // Извлекаем ID товаров
    const idMatch = aiText.match(/\[PRODUCT_IDS:\s*([\w\s,]+)\]/);
    let productButtons: any[] = [];
    
    if (idMatch) {
      const ids = idMatch[1].split(',').map(id => id.trim());
      aiText = aiText.replace(/\[PRODUCT_IDS:.*?\]/, '').trim();
      
      // Сохраняем в кэш для навигации
      if (ctx.from?.id) {
        aiResultsCache[ctx.from.id] = ids;
      }
      
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const product = allProducts.find(p => p.id === id);
        if (product) {
          productButtons.push([Markup.button.callback(`🔍 Посмотреть: ${product.name}`, `view_ai_${i}`)]);
        }
      }
    }

    if (productButtons.length > 0) {
      await ctx.reply(aiText, { 
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(productButtons)
      });
    } else {
      await ctx.reply(aiText, { parse_mode: 'HTML' });
    }
  } catch (error: any) {
    console.error('AI Error:', error);
    if (error?.message?.includes('API key not valid')) {
      // Пробуем обновить ключ перед тем как сдаться
      await refreshAIKey();
      ctx.reply('⚠️ <b>Ошибка ИИ:</b> Недействительный API ключ. Если вы только что его вставили, попробуйте еще раз. Если нет — используйте команду /set_ai_key ВАШ_КЛЮЧ', { parse_mode: 'HTML' });
    } else {
      ctx.reply('⚠️ Извини, мой модный процессор перегрелся. Попробуй позже!');
    }
  }
};

// Обработка прямого просмотра товара (из ИИ)
bot.action(/^view_ai_(\d+)$/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1]);
    const userId = ctx.from?.id;
    const ids = userId ? aiResultsCache[userId] : null;
    
    if (!ids || !ids[index]) {
      return ctx.answerCbQuery('Результаты ИИ устарели. Попробуйте еще раз.');
    }

    const productId = ids[index];
    const productDoc = await getDoc(doc(db, 'products', productId));
    
    if (!productDoc.exists()) {
      return ctx.answerCbQuery('Товар больше не существует');
    }

    await ctx.answerCbQuery();
    await clearUserMessages(ctx);
    
    const p = productDoc.data() as Product;
    await sendProduct(ctx, p, productDoc.id, false, {
      type: 'ai',
      query: 'last',
      index: index,
      total: ids.length
    });
  } catch (e) {
    console.error('Ошибка просмотра товара ИИ:', e);
    ctx.answerCbQuery('Ошибка при загрузке товара');
  }
});

bot.action(/^view_(.+)$/, async (ctx) => {
  try {
    const productId = ctx.match[1];
    const productDoc = await getDoc(doc(db, 'products', productId));
    
    if (!productDoc.exists()) {
      return ctx.answerCbQuery('Товар больше не существует');
    }

    await ctx.answerCbQuery();
    await clearUserMessages(ctx);
    
    const p = productDoc.data() as Product;
    await sendProduct(ctx, p, productDoc.id, false);
  } catch (e) {
    console.error('Ошибка просмотра товара:', e);
    ctx.answerCbQuery('Ошибка при загрузке товара');
  }
});

// Команда для установки ключа через чат (только для админов)
bot.command('set_ai_key', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = ctx.message.text.split(' ')[1];
  if (!text) {
    return ctx.reply('⚠️ <b>Использование:</b>\n<code>/set_ai_key ВАШ_КЛЮЧ</code>', { parse_mode: 'HTML' });
  }

  try {
    await setDoc(doc(db, 'settings', 'gemini'), { apiKey: text });
    await refreshAIKey();
    return ctx.reply('✅ <b>API КЛЮЧ УСПЕШНО СОХРАНЕН!</b>\n\nТеперь ИИ-стилист должен работать.', { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Ошибка сохранения ключа:', e);
    return ctx.reply('❌ Ошибка при сохранении ключа в базу данных.');
  }
});

// Поиск
bot.hears('🔍 ПОИСК', (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && adminState[userId]) return next();
  ctx.reply('🔍 <b>ВВЕДИТЕ НАЗВАНИЕ ТОВАРА ДЛЯ ПОИСКА:</b>', { parse_mode: 'HTML' });
});

// --- Админ-панель ---

bot.hears('🛠 АДМИН-ПАНЕЛЬ', async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && adminState[userId]) return next();
  if (!isAdmin(ctx)) return;
  return ctx.reply('🛠 <b>ПАНЕЛЬ АДМИНИСТРАТОРА</b>\n\nВыберите действие:', 
    {
      parse_mode: 'HTML',
      ...Markup.keyboard([
        ['➕ ДОБАВИТЬ ТОВАР', '📦 УПРАВЛЕНИЕ'],
        ['📢 РАССЫЛКА', '🔧 ИСПРАВИТЬ БД'],
        ['🔙 В МЕНЮ']
      ]).resize()
    }
  );
});

bot.hears('🔧 ИСПРАВИТЬ БД', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply('⏳ <b>НАЧИНАЮ МИГРАЦИЮ ТОВАРОВ...</b>\n\nЯ проставлю локацию "В наличии" всем товарам, у которых она не указана.', { parse_mode: 'HTML' });
  
  try {
    const productsSnap = await getDocs(collection(db, 'products'));
    let updatedCount = 0;
    
    for (const productDoc of productsSnap.docs) {
      const data = productDoc.data();
      if (!data.location) {
        await updateDoc(doc(db, 'products', productDoc.id), {
          location: LOCATIONS.LOCAL
        });
        updatedCount++;
      }
    }
    
    return ctx.reply(`✅ <b>МИГРАЦИЯ ЗАВЕРШЕНА!</b>\n\nОбновлено товаров: ${updatedCount}`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Ошибка миграции:', e);
    return ctx.reply('❌ Ошибка при обновлении базы данных.');
  }
});

bot.hears('📢 РАССЫЛКА', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const userId = ctx.from!.id;
  adminState[userId] = { step: 'WAIT_BROADCAST', data: {} };
  return ctx.reply('📢 <b>ВВЕДИТЕ ТЕКСТ ДЛЯ РАССЫЛКИ:</b>\n\nЭто сообщение будет отправлено всем пользователям бота.', 
    {
      parse_mode: 'HTML',
      ...Markup.keyboard([['❌ ОТМЕНА']]).resize()
    }
  );
});
bot.hears('📦 УПРАВЛЕНИЕ', async (ctx) => {
  if (!isAdmin(ctx)) return;
  return ctx.reply('📦 <b>УПРАВЛЕНИЕ ТОВАРАМИ</b>\n\nВыберите локацию для управления:', 
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🛍 В НАЛИЧИИ', 'manage_loc_local')],
        [Markup.button.callback('🇨🇳 КИТАЙ', 'manage_loc_china')]
      ])
    }
  );
});

bot.action(/^manage_loc_(local|china)$/, async (ctx) => {
  const location = ctx.match[1];
  const locText = location === 'china' ? 'ИЗ КИТАЯ' : 'В НАЛИЧИИ';
  return ctx.editMessageText(`📦 <b>УПРАВЛЕНИЕ (${locText})</b>\n\nВыберите категорию:`, 
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(
        chunkArray(
          CATEGORIES.map(cat => Markup.button.callback(`⚙️ ${cat.toUpperCase()}`, `manage_cat_${location}_${cat}`)),
          2
        )
      )
    }
  );
});

// Обработка категорий в режиме управления
bot.action(/^manage_cat_(local|china)_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Нет доступа');
  try {
    const location = ctx.match[1];
    const category = ctx.match[2];
    const q = query(
      collection(db, 'products'),
      where('location', '==', location),
      where('category', '==', category),
      orderBy('createdAt', 'desc')
    );
    const productsSnap = await getDocs(q);

    if (productsSnap.empty) {
      await ctx.answerCbQuery();
      const locText = location === 'china' ? 'из Китая' : 'в наличии';
      return ctx.reply(`В категории "<b>${category}</b>" (${locText}) нет товаров для управления.`, { parse_mode: 'HTML' });
    }

    await ctx.answerCbQuery();
    await clearUserMessages(ctx);
    const p = productsSnap.docs[0].data() as Product;
    await sendProduct(ctx, p, productsSnap.docs[0].id, true, {
      type: `manage_${location}`,
      query: category,
      index: 0,
      total: productsSnap.docs.length
    });
  } catch (error) {
    console.error('Ошибка управления:', error);
    ctx.reply('Ошибка при загрузке товаров для управления.');
  }
});

// Добавление товара (пошаговое)
bot.hears('➕ ДОБАВИТЬ ТОВАР', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const userId = ctx.from!.id;
  adminState[userId] = { step: 'WAIT_NAME', data: {} };
  return ctx.reply('📝 <b>ВВЕДИТЕ НАЗВАНИЕ ТОВАРА:</b>', 
    {
      parse_mode: 'HTML',
      ...Markup.keyboard([['❌ ОТМЕНА']]).resize()
    }
  );
});

bot.command('skip', async (ctx) => {
  const userId = ctx.from!.id;
  if (adminState[userId] && adminState[userId].step === 'WAIT_PHOTO') {
    return finishProductProcess(ctx);
  }
});

// Удаление и Редактирование через Inline кнопки
bot.action(/^del_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Нет доступа');
  const id = ctx.match[1];
  try {
    const docRef = doc(db, 'products', id);
    await deleteDoc(docRef);
    await ctx.answerCbQuery('Удалено');
    
    const text = '🗑 <b>Товар удален из базы.</b>';
    const message = ctx.callbackQuery.message as any;
    
    // Если это медиа-сообщение (фото), используем editMessageCaption
    if (message && (message.photo || message.video || message.document)) {
      return ctx.editMessageCaption(text, { parse_mode: 'HTML' });
    } else {
      // Иначе (текстовое сообщение), используем editMessageText
      return ctx.editMessageText(text, { parse_mode: 'HTML' });
    }
  } catch (e) {
    return ctx.answerCbQuery('Ошибка удаления');
  }
});

bot.action(/^edit_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Нет доступа');
  const id = ctx.match[1];
  const userId = ctx.from!.id;
  
  const docRef = doc(db, 'products', id);
  const productDoc = await getDoc(docRef);
  if (!productDoc.exists()) return ctx.answerCbQuery('Товар не найден');
  
  adminState[userId] = { 
    step: 'WAIT_NAME', 
    data: {}, 
    editId: id 
  };
  
  await ctx.answerCbQuery();
  return ctx.reply('📝 <b>Редактирование товара. Введите новое название:</b>', {
    parse_mode: 'HTML',
    ...Markup.keyboard([['❌ ОТМЕНА']]).resize()
  });
});

bot.hears('🔙 В МЕНЮ', (ctx) => showMainMenu(ctx));

bot.action(/^buy_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    '🛍 <b>ДЛЯ ОФОРМЛЕНИЯ ЗАКАЗА:</b>\n\n' +
    'Пожалуйста, напишите нашему менеджеру для уточнения деталей оплаты и доставки:\n\n' +
    '👤 <b>МЕНЕДЖЕР:</b> @darkstepmanager\n\n' +
    '🚀 <i>Просто отправьте ему название товара или скриншот!</i>',
    { parse_mode: 'HTML' }
  );
});

// --- Server ---

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Health check for Cloud Run / Railway
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', bot: !!token });
  });

  // Простой HTML для превью, чтобы не было ошибки 404
  app.get('/', (req, res) => {
    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h1>🤖 DARKSTEP Bot is Running</h1>
        <p>Веб-интерфейс отключен. Бот работает в Telegram.</p>
        <a href="https://t.me/darkstep_shop_bot" style="color: #0088cc; text-decoration: none; font-weight: bold;">Открыть бота в Telegram</a>
      </div>
    `);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server on port ${PORT}`);
    if (token) {
      bot.launch().then(() => console.log('Bot started!'));
    }
  });
}

startServer();
