require('dotenv').config();

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  }
  return v;
}

module.exports = {
  port: Number(process.env.PORT || 9009),
  jwtSecret: required('JWT_SECRET', 'dev-insecure-secret-change-me'),
  devMode: String(process.env.DEV_MODE || 'true').toLowerCase() === 'true',

  // Общий self-hosted Supabase (тот же инстанс, где живут схемы erp/warehouse).
  // MDM хранит свои данные в собственной схеме "mdm" в этом же Postgres —
  // как это уже сделано для модуля Склада (схема "warehouse"), см. README.
  supabaseRestUrl: process.env.SUPABASE_REST_URL || 'http://10.66.0.105:8000/rest/v1',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  mdmSchema: process.env.MDM_SCHEMA || 'mdm',

  // Отдельный облачный Supabase-проект модуля Закупок (не тот self-hosted
  // инстанс, где живут erp/warehouse/mdm) — источник справочников поставщиков
  // и номенклатуры для встречной синхронизации "снизу вверх" (см. bulkSyncService.js).
  procurementSupabaseUrl: process.env.PROCUREMENT_SUPABASE_URL || '',
  procurementSupabaseServiceRoleKey: process.env.PROCUREMENT_SUPABASE_SERVICE_ROLE_KEY || '',
};
