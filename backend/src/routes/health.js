const express = require('express');
const router = express.Router();

// Обязательный контракт из MODULE_DEVELOPER_GUIDE.md: ERP Gateway дергает этот
// путь при подключении модуля и ожидает 200 OK.
router.get('/', (req, res) => {
    res.json({ status: 'ok', module: 'MDM', version: '0.1.0' });
});

module.exports = router;
