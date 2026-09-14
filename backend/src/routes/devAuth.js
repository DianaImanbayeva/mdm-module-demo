// ТОЛЬКО для локальной разработки: подписывает тестовый SSO-токен тем же
// JWT_SECRET, каким его подписывал бы ERP Core, чтобы можно было прогнать
// весь модуль end-to-end до реального подключения к ERP. Отключается через
// DEV_MODE=false в .env (см. server.js, где роут вообще не монтируется).
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const router = express.Router();
const { jwtSecret } = require('../config/env');

router.post('/login', (req, res) => {
    const { role = 'steward', email = 'demo@asgroup.kz', organization_id = 'org-demo-000' } = req.body || {};

    const token = jwt.sign(
        {
            sub: crypto.randomUUID(),
            email,
            role, // 'user' | 'steward'
            app_metadata: { organization_id },
        },
        jwtSecret,
        { expiresIn: '8h' }
    );

    res.json({ token });
});

module.exports = router;
