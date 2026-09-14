// Источник кандидатов CostCAS WBS (см. C:\MDM\costcas_export) — государственная
// сметная база Азербайджана (ДЕСН), выгруженная один раз через внешний API
// (временный Bearer-токен) и сохранённая локально в JSON. Читаем отсюда, а не
// заново дёргаем внешний API — токен истекает, а данные уже есть на диске.
const fs = require('fs');
const path = require('path');

const EXPORT_DIR = path.join(__dirname, '..', '..', '..', 'costcas_export');

let cache = null;
function loadExport() {
    if (cache) return cache;
    cache = {
        jobs: JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'jobs.json'), 'utf8')),
        resources: JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'resources.json'), 'utf8')),
    };
    return cache;
}

function paginate(items, { limit = 200, offset = 0 } = {}) {
    return items.slice(offset, offset + limit);
}

async function fetchJobs(opts) {
    const { jobs } = loadExport();
    return paginate(jobs, opts).map(j => ({ erp_id: j.code, name: j.name, code: j.code, unit: j.measure || null }));
}

async function fetchResourcesByType(type, opts) {
    const { resources } = loadExport();
    const filtered = resources.filter(r => r.type === type);
    return paginate(filtered, opts).map(r => ({ erp_id: r.code, name: r.name, code: r.code, unit: r.measure || null }));
}

module.exports = {
    fetchJobs,
    fetchMachines: (opts) => fetchResourcesByType('machine', opts),
    fetchMaterials: (opts) => fetchResourcesByType('material', opts),
};
