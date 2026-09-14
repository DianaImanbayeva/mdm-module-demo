// Эмуляция шины Kafka из ТЗ ("Транспортный слой (Шина)", контуры Инициации/MDM/
// Дистрибуции). В реальной экосистеме AS Group интеграция между модулями сейчас
// делается не через Kafka, а прямыми REST-вызовами по URL из .env (см. пример
// STORE_API_URL в модуле Закупок) — на неё эта заглушка легко переключается:
// достаточно заменить publish() на реальный вызов брокера/соседнего модуля,
// остальной код (места вызова) трогать не нужно. Пока события просто пишутся
// в mdm.mdm_bus_events, чтобы дашборд мог показать "Мониторинг шины" (п.8 ТЗ).
const pg = require('./pgrest');
const { mdmSchema } = require('../config/env');

const TOPICS = {
    RAW_REQUESTS: 'mdm.raw.requests',
    GOLDEN_UPDATES: 'mdm.golden.updates',
};

async function publish(topic, payload) {
    await pg.post(mdmSchema, 'mdm_bus_events', { topic, payload, status: 'delivered' }, 'return=minimal');
}

async function recentEvents(limit = 20) {
    const rows = await pg.get(mdmSchema, 'mdm_bus_events', {
        select: 'id,topic,payload,status,created_at',
        order: 'created_at.desc',
        limit: String(limit),
    });
    return rows || [];
}

module.exports = { TOPICS, publish, recentEvents };
