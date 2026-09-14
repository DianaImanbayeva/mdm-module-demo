// Расстояние Левенштейна — вторая, независимая от pg_trgm метрика нечёткого
// сопоставления (см. "нечеткий поиск.pdf": минимальное число правок —
// вставок/замен/удалений, — чтобы одна строка превратилась в другую).
// Используется как дополнительный процент рядом с pg_trgm similarity, а не
// вместо неё — обе метрики ловят разные виды несовпадений (pg_trgm — общий
// набор кусочков по 3 буквы, Левенштейн — точные посимвольные правки).

function levenshteinDistance(a, b) {
    const s1 = String(a || '');
    const s2 = String(b || '');
    const m = s1.length;
    const n = s2.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prevRow = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const currRow = [i];
        for (let j = 1; j <= n; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            currRow[j] = Math.min(
                currRow[j - 1] + 1,   // вставка
                prevRow[j] + 1,        // удаление
                prevRow[j - 1] + cost, // замена
            );
        }
        prevRow = currRow;
    }
    return prevRow[n];
}

// Нормализация в проценты (0..1), как similarity() из pg_trgm, чтобы обе
// метрики можно было сравнивать по одной шкале в интерфейсе.
function levenshteinSimilarity(a, b) {
    const s1 = String(a || '');
    const s2 = String(b || '');
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(s1, s2) / maxLen;
}

module.exports = { levenshteinDistance, levenshteinSimilarity };
