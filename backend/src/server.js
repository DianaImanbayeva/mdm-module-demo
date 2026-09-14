const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { port, devMode } = require('./config/env');
const { requireAuth } = require('./middleware/auth');
const { journalMiddleware } = require('./middleware/journal');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Контракт из MODULE_DEVELOPER_GUIDE.md, п.5: модуль обязан разрешить встраивание
// себя в iframe ERP через явные заголовки.
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

app.use((req, res, next) => {
    console.log(`[MDM] ${req.method} ${req.url}`);
    next();
});

// /health — без авторизации, ERP Gateway должен достучаться до него всегда.
app.use('/health', require('./routes/health'));

if (devMode) {
    console.log('⚠️  DEV_MODE включён: доступен POST /dev/login для тестового SSO-токена. Отключить в .env перед продом.');
    app.use('/dev', require('./routes/devAuth'));
}

// Всё остальное API — только с проверенным SSO-токеном ERP.
// Журнал стоит после requireAuth: ему нужна личность из req.user. Событие
// отправляется в res.on('finish'), то есть уже после ответа клиенту - ни
// обработчик, ни пользователь журнал не ждут.
// Нажатия из браузера. Пара к frontend/public/journal-ui.js: серверу видны
// только запросы, и на вопрос «куда человек нажал» отвечает лишь браузер.
//
// Объявлено ДО app.use('/api/v1', ...) намеренно: маршрутизатор mdm отвечает на
// неизвестные пути 404, и, стоя после него, эта ручка не получила бы запрос.
// journalMiddleware сюда не подключён - приём событий журнала сам событием не
// является.
const { createUiRoute } = require('./journal/express-ui');
app.post('/api/v1/journal/ui', requireAuth, createUiRoute());

app.use('/api/v1', requireAuth, journalMiddleware, require('./routes/mdm'));
app.use('/api/v1/erp', requireAuth, journalMiddleware, require('./routes/erp'));

app.use('/api', (req, res) => {
    res.status(404).json({ error: `Маршрут не найден: ${req.method} ${req.originalUrl}` });
});

// Весь модуль отдаётся с одного порта: собранный фронтенд (frontend/dist) как
// статика на том же порту, где живут /health и /api/v1 — ERP Gateway получает
// один адрес на модуль (как договорились: один порт 9009), без отдельного
// фронтенд-процесса/порта в проде.
const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
    console.log(`ℹ️  frontend/dist не найден — запустите "npm run build" в frontend/, чтобы отдавать интерфейс с этого же порта.`);
    console.log(`   Пока используйте отдельный "npm run dev" в frontend/ (vite proxy на этот backend).`);
}

app.listen(port, () => {
    console.log(`🗂️  MDM backend запущен: http://localhost:${port}`);
    console.log(`   Health check: GET  http://localhost:${port}/health`);
    console.log(`   API:          *    http://localhost:${port}/api/v1/...`);
});
