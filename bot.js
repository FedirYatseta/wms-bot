const { Bot, Keyboard, GrammyError, HttpError } = require("grammy");
require('dotenv').config();
const oracledb = require('oracledb');

// Підключення до бота
const bot = new Bot(process.env.BOT_API_KEY);

// Підключення до Oracle DB
async function getProcessedData(depot, startDate, endDate) {
  let connection;

  try {
    // Встановлення з'єднання з базою даних
    connection = await oracledb.getConnection({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECTION_STRING
    });

    // Виконання SQL-запиту з параметрами депо і дати
    const result = await connection.execute(
      `SELECT LP_DEPOT AS "Депо", 
              TO_DATE(START_OTB - 8/24) AS "Дата зміни", 
              SUM(SKU) AS "К-сть, шт", 
              SUM(STROK) AS "Рядків"
       FROM (SELECT DISTINCT * 
             FROM STK511PROD.CR_DISTR_DETAIL_HIST 
             WHERE START_OTB BETWEEN TO_DATE(:startDate, 'dd.mm.yyyy') + 8/24 
             AND TO_DATE(:endDate, 'dd.mm.yyyy') + 32/24 - 1/24/60/60 
             AND (:depot = 'all' OR LP_DEPOT = :depot))
       GROUP BY LP_DEPOT, TO_DATE(START_OTB - 8/24)
       ORDER BY LP_DEPOT, TO_DATE(START_OTB - 8/24)`,
      { depot, startDate, endDate }
    );

    // Повернення результату запиту
    return result.rows;
  } catch (err) {
    console.error(err);
  } finally {
    // Закриваємо з'єднання
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error(err);
      }
    }
  }
}

// Функція для форматування чисел з пробілами
function numberWithSpaces(x) {
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// Команда /start
bot.command("start", (ctx) => ctx.reply("Вітаємо! Бот готовий до роботи."));

// Налаштування меню
bot.api.setMyCommands([{
  command: 'start', description: 'Запуск бота'
}, {
  command: 'menu', description: 'Меню'
}]);

// Команда меню
bot.command("menu", async (ctx) => {
  const menuKeyboard = new Keyboard().text('Виробіток дистрибуції по змінах (днях)').row().resized();
  await ctx.reply('Що хочеш отримати?', {
    reply_markup: menuKeyboard
  });
});

// Обробка "Обробка за депо"
bot.hears('Виробіток дистрибуції по змінах (днях)', async (ctx) => {
  const depotKeyboard = new Keyboard()
    .text('Депо 01').row()
    .text('Депо 02').row()
    .text('Депо 03').row()
    .text('Всі депо').row()
    .resized();

  await ctx.reply('Оберіть депо:', {
    reply_markup: depotKeyboard
  });
});

// Обробка вибору депо
let selectedDepot = ''; // Збереження вибраного депо
let startDate = ''; // Збереження початкової дати
let endDate = ''; // Збереження кінцевої дати

bot.hears(['Депо 01', 'Депо 02', 'Депо 03', 'Всі депо'], async (ctx) => {
  selectedDepot = ctx.message.text === 'Всі депо' ? 'all' : ctx.message.text.split(' ')[1];
  await ctx.reply('Введіть початкову дату в форматі dd.mm.yyyy:');
});

// Обробка вибору дати
bot.on('message:text', async (ctx) => {
  const datePattern = /^\d{2}\.\d{2}\.\d{4}$/;
  const currentDate = new Date();

  if (!startDate && datePattern.test(ctx.message.text)) {
    const inputDate = new Date(ctx.message.text.split('.').reverse().join('-'));
    if (inputDate > currentDate) {
      await ctx.reply('Початкова дата не може бути в майбутньому. Введіть коректну дату.');
      return;
    }
    startDate = ctx.message.text;
    await ctx.reply('Введіть кінцеву дату в форматі dd.mm.yyyy:');
  } else if (startDate && datePattern.test(ctx.message.text)) {
    const inputEndDate = new Date(ctx.message.text.split('.').reverse().join('-'));
    const inputStartDate = new Date(startDate.split('.').reverse().join('-'));

    if (inputEndDate < inputStartDate) {
      await ctx.reply('Кінцева дата не може бути раніше початкової. Введіть коректну дату.');
      return;
    }

    endDate = ctx.message.text;

    // Після введення дати, виконуємо SQL-запит
    const result = await getProcessedData(selectedDepot, startDate, endDate);

    if (result && result.length > 0) {
      let depotData = {};  // Об'єкт для зберігання сумарних даних по кожному депо

      result.forEach(row => {
        const depot = row[0];  // Депо
        const units = row[2];  // Кількість юнітів
        const rows = row[3];   // Кількість рядків

        if (!depotData[depot]) {
          depotData[depot] = {
            totalUnits: 0,
            totalRows: 0
          };
        }

        depotData[depot].totalUnits += units;
        depotData[depot].totalRows += rows;
      });

      // Форматування початкової та кінцевої дати
      const formattedStartDate = new Date(startDate.split('.').reverse().join('-')).toLocaleDateString('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });

      const formattedEndDate = new Date(endDate.split('.').reverse().join('-')).toLocaleDateString('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });

      // Формування відповіді
      let replyText = 'Результати:\n\n';

      for (const depot in depotData) {
        replyText += `Депо: ${depot}\n`;
        if (startDate === endDate) {
          replyText += `Дата: ${formattedStartDate}\n`;
        } else {
          replyText += `Дата: ${formattedStartDate} - ${formattedEndDate}\n`;
        }
        replyText += `Кількість юнітів: ${numberWithSpaces(depotData[depot].totalUnits)}\n`;
        replyText += `Кількість рядків: ${numberWithSpaces(depotData[depot].totalRows)}\n\n`;
      }

      await ctx.reply(replyText);
    } else {
      await ctx.reply('Дані відсутні для вказаного інтервалу.');
    }

    // Очищення змінних після виконання
    selectedDepot = '';
    startDate = '';
    endDate = '';
  } else {
    await ctx.reply('Будь ласка, введіть дату в правильному форматі (dd.mm.yyyy).');
  }
});

// Обробка некоректного введення
bot.on('message', async (ctx) => {
  await ctx.reply('Невідоме введення. Будь ласка, оберіть дію з меню або введіть дату в форматі dd.mm.yyyy.');
});

// Обробка помилок
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Error in request:", e.description);
  } else if (e instanceof HttpError) {
    console.error("Could not contact Telegram:", e);
  } else {
    console.error("Unknown error:", e);
  }
});

// Запуск бота
bot.start();
