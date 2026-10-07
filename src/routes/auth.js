const express = require('express');
const auth = require('../services/auth');

const router = express.Router();

router.get('/status', (req, res) => {
  const session = auth.sessionFromRequest(req);
  res.json({
    setup_required: !auth.hasAdmin(),
    authenticated: !!session,
    username: session?.username || null,
  });
});

router.post('/register', (req, res) => {
  try {
    const data = auth.register(req.body?.username, req.body?.password);
    const session = auth.login(req.body?.username, req.body?.password);
    res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=${session.token}; ${auth.cookieOptions(req)}`);
    res.status(201).json({ data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', (req, res) => {
  const session = auth.login(req.body?.username, req.body?.password);
  if (!session) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=${session.token}; ${auth.cookieOptions(req)}`);
  res.json({ data: { username: session.username } });
});

router.post('/logout', (req, res) => {
  auth.logout(auth.sessionFromRequest(req)?.token);
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=; ${auth.clearCookie(req)}`);
  res.json({ ok: true });
});

module.exports = router;
