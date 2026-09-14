// Единый клиент к общему self-hosted Supabase через PostgREST/Kong. Схема
// передаётся явным параметром — так один клиент обслуживает и запись в "mdm"
// (собственные данные модуля), и (при необходимости) чтение других схем.
const { supabaseRestUrl, supabaseServiceRoleKey } = require('../config/env');

async function request(schema, method, path, { params, body, prefer, countOnly } = {}) {
    if (!supabaseServiceRoleKey) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY не задан в .env');
    }
    const url = new URL(`${supabaseRestUrl}/${path}`);
    for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }

    const headers = {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
    };
    headers[method === 'GET' || method === 'HEAD' ? 'Accept-Profile' : 'Content-Profile'] = schema;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const preferParts = [];
    if (prefer) preferParts.push(prefer);
    if (countOnly) preferParts.push('count=exact');
    if (preferParts.length) headers['Prefer'] = preferParts.join(',');

    const res = await fetch(url, {
        method: countOnly ? 'HEAD' : method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`PostgREST ${schema} ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }

    if (countOnly) {
        const range = res.headers.get('content-range'); // "0-9/42"
        return range ? Number(range.split('/')[1]) : 0;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

module.exports = {
    get: (schema, path, params) => request(schema, 'GET', path, { params }),
    post: (schema, path, body, prefer = 'return=representation') => request(schema, 'POST', path, { body, prefer }),
    patch: (schema, path, params, body, prefer = 'return=representation') => request(schema, 'PATCH', path, { params, body, prefer }),
    rpc: (schema, fn, args) => request(schema, 'POST', `rpc/${fn}`, { body: args }),
    count: (schema, path, params) => request(schema, 'GET', path, { params, countOnly: true }),
};
