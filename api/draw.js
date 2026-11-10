// GET  /api/draw?url=...   -> есть ли уже сохранённый результат для этой темы
// POST /api/draw           -> провести розыгрыш (один раз на тему) или вернуть уже сохранённый
// Хранилище: Upstash Redis (REST). Ключ = draw:<id темы>, запись через SET NX (атомарно).
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ALLOWED_HOST = 'forum.comeback.pw';

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('База не подключена: нет переменных окружения Upstash/KV');
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const d = await r.json();
  if (d.error) throw new Error('Redis: ' + d.error);
  return d.result;
}

// https://forum.comeback.pw/threads/slug.20277/page-3 -> "20277"
function threadId(input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) return null;
  const m = u.pathname.match(/^\/threads\/[^/]*\.(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const id = threadId(req.query.url || '');
      if (!id) return res.status(400).json({ error: `Нужна ссылка на тему https://${ALLOWED_HOST}/threads/...` });
      const stored = await redis(['GET', `draw:${id}`]);
      return res.json({ exists: !!stored, result: stored ? JSON.parse(stored) : null });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};
    const id = threadId(body.url || '');
    if (!id) return res.status(400).json({ error: `Нужна ссылка на тему https://${ALLOWED_HOST}/threads/...` });
    const key = `draw:${id}`;

    // Сброс только для админа: старый результат архивируется, а не удаляется
    if (body.reset) {
      const admin = process.env.ADMIN_TOKEN;
      if (!admin || body.token !== admin) return res.status(403).json({ error: 'Неверный админ-токен' });
      const exists = await redis(['EXISTS', key]);
      if (exists) await redis(['RENAME', key, `${key}:archived:${Date.now()}`]);
      return res.json({ reset: true });
    }

    // Уже разыгрывали — отдаём сохранённое, ничего не пересчитываем
    const existing = await redis(['GET', key]);
    if (existing) return res.json({ exists: true, result: JSON.parse(existing) });

    // ---- Жеребьёвка ----
    const s = body.settings || {};
    const count = Math.max(1, Math.min(1000, parseInt(s.count, 10) || 1));
    let posts = Array.isArray(body.posts) ? body.posts : [];
    if (!posts.length) return res.status(400).json({ error: 'Список сообщений пуст' });
    posts = posts.slice(0, 50000).map((p) => ({
      postId: String(p.postId || ''), number: String(p.number || ''), author: String(p.author || ''),
      text: String(p.text || '').slice(0, 400), url: String(p.url || ''),
    })).filter((p) => p.author && p.url.startsWith(`https://${ALLOWED_HOST}/posts/`));

    const total = posts.length;
    const starter = posts[0] && posts[0].author;
    posts = posts.slice(Math.max(0, parseInt(s.skipFirst, 10) || 0));
    if (s.excludeAuthor && starter) posts = posts.filter((p) => p.author !== starter);
    const kw = String(s.keyword || '').trim().toLowerCase();
    if (kw) posts = posts.filter((p) => p.text.toLowerCase().includes(kw));
    const minLen = parseInt(s.minLength, 10) || 0;
    if (minLen > 0) posts = posts.filter((p) => p.text.length >= minLen);

    let pool = posts;
    if (s.uniqueUsers) {
      const m = new Map();
      for (const p of posts) if (!m.has(p.author)) m.set(p.author, p);
      pool = [...m.values()];
    }
    if (!pool.length) return res.status(422).json({ error: 'Нет подходящих сообщений для розыгрыша (результат не сохранён)' });

    const winners = shuffle(pool).slice(0, count);
    const participants = pool.map((p) => ({ author: p.author, number: p.number, url: p.url }));
    const result = {
      threadId: id,
      url: body.url,
      drawnAt: new Date().toISOString(),
      settings: { count, uniqueUsers: !!s.uniqueUsers, excludeAuthor: !!s.excludeAuthor, keyword: kw, minLength: minLen, skipFirst: parseInt(s.skipFirst, 10) || 0 },
      total,
      eligible: pool.length,
      winners,
      participants,
      participantsHash: crypto.createHash('sha256').update(JSON.stringify(participants)).digest('hex'),
    };

    // NX: запишется, только если ключа ещё нет. При гонке двух запросов победит один.
    const ok = await redis(['SET', key, JSON.stringify(result), 'NX']);
    if (!ok) {
      const again = await redis(['GET', key]);
      return res.json({ exists: true, result: JSON.parse(again) });
    }
    return res.json({ exists: false, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
