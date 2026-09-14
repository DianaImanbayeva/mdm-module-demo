// Проверка SSO-токена, который ERP Core прикрепляет к URL модуля при открытии
// (см. корневой MODULE_DEVELOPER_GUIDE.md, п.4). Токен подписан HS256 общим
// JWT_SECRET. Фронтенд ловит его один раз из ?token=... и дальше присылает
// на backend в заголовке Authorization: Bearer <token> на каждый запрос.
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');
const audit = require('../journal/audit-client');

function extractToken(req) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice(7);
    if (req.query.token) return String(req.query.token);
    return null;
}

function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Токен авторизации отсутствует' });
    }
    try {
        const decoded = jwt.verify(token, jwtSecret);
        // В реальном токене ERP (Supabase Auth) верхнеуровневое поле "role" всегда
        // "authenticated"/"anon"/"service_role" — это служебная роль Postgres для RLS,
        // а не бизнес-роль пользователя. Бизнес-роль (admin/steward/user) лежит в
        // app_metadata.role — так и оказалось на реальном токене от super_boss@mail.ru.
        // decoded.role оставлен как запасной вариант для тестовых /dev/login-токенов,
        // которые для простоты кладут роль на верхний уровень.
        req.user = {
            id: decoded.sub,
            email: decoded.email,
            role: decoded.app_metadata?.role || decoded.role,
            organizationId: decoded.app_metadata?.organization_id || null,
        };
        // Вход - в раздел «Входы и отказы» общего журнала. Пропуск проверяется
        // на каждом запросе, поэтому recordSession сам отсекает повторы по
        // личности на минуту: иначе раздел состоял бы из одной строки «вошёл»,
        // повторённой сотни раз за сессию.
        audit.recordSession('LOGIN', {
            entityType: 'mdm_session',
            actorId: req.user.id,
            actorEmail: req.user.email,
            actorName: req.user.email,
            actorRole: req.user.role,
            organizationId: req.user.organizationId || '',
            sessionId: decoded.jti || '',
            ipAddress: req.ip || req.socket?.remoteAddress || '',
            userAgent: req.headers?.['user-agent'] || '',
        });
        next();
    } catch (err) {
        // Отказ нужен службе безопасности, поэтому личность достаём из
        // непроверенного токена: подпись не сошлась, но чей это был пропуск -
        // видно. Сам токен в журнал не попадает: по нему можно было бы войти.
        let claims = {};
        try {
            claims = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8')) || {};
        } catch {
            claims = {};
        }
        audit.recordSession('ACCESS_DENIED', {
            entityType: 'mdm_session',
            reason: err.message,
            actorId: claims.sub || '',
            actorEmail: claims.email || '',
            actorName: claims.email || '',
            actorRole: claims.app_metadata?.role || '',
            organizationId: claims.app_metadata?.organization_id || '',
            ipAddress: req.ip || req.socket?.remoteAddress || '',
            userAgent: req.headers?.['user-agent'] || '',
        });
        res.status(401).json({ error: 'Токен недействителен: ' + err.message });
    }
}

// Действие доступно только "Стюарду данных" (роль из ТЗ) — обычный пользователь
// может только отправлять сырые заявки, но не разрешать конфликты и не заводить
// эталоны напрямую (см. п.4 разбора ТЗ: 2 роли — Пользователь и Стюард данных).
function requireSteward(req, res, next) {
    if (req.user?.role !== 'steward' && req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Действие доступно только роли "Стюард данных"' });
    }
    next();
}

module.exports = { requireAuth, requireSteward };
