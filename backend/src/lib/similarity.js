// Реализация, повторяющая алгоритм similarity() из расширения PostgreSQL pg_trgm
// (см. ТЗ п. "Движок Дедупликации" — сопоставление на базе pg_trgm), чтобы модуль
// мог работать на собственной SQLite-базе без внешнего Postgres, сохранив те же
// пороги (0.55 / 0.25), откалиброванные ранее на реальных значениях pg_trgm для
// коротких кириллических названий стройматериалов.
//
// pg_trgm дополняет строку двумя пробелами спереди и одним сзади, разбивает её на
// все подстроки длиной 3 символа (триграммы) и считает similarity как
// |пересечение| / |объединение| множеств триграмм двух строк.

function trigramSet(str) {
    const padded = '  ' + str + ' ';
    const set = new Set();
    for (let i = 0; i <= padded.length - 3; i++) {
        set.add(padded.slice(i, i + 3));
    }
    return set;
}

function normalizeName(raw) {
    return String(raw || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function similarity(a, b) {
    const sa = trigramSet(a);
    const sb = trigramSet(b);
    if (sa.size === 0 || sb.size === 0) return 0;

    let intersection = 0;
    for (const t of sa) {
        if (sb.has(t)) intersection++;
    }
    const union = sa.size + sb.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

module.exports = { similarity, normalizeName };
