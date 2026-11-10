// GET /api/page?url=<ссылка на страницу темы>
// Загружает ОДНУ страницу темы XenForo и возвращает посты + ссылку на следующую страницу.
const cheerio = require('cheerio');

const ALLOWED_HOST = 'forum.comeback.pw';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseUrl(input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) return null;
  u.hash = '';
  return u;
}

module.exports = async (req, res) => {
  const u = parseUrl(req.query.url || '');
  if (!u) return res.status(400).json({ error: `Допускаются только ссылки https://${ALLOWED_HOST}/...` });

  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' } });
    if (!r.ok) return res.status(502).json({ error: `Форум ответил HTTP ${r.status}` });
    const html = await r.text();
    const $ = cheerio.load(html);

    const posts = [];
    $('article.message--post').each((_, el) => {
      const $el = $(el);
      const author = $el.attr('data-author') || $el.find('.message-userDetails .username').first().text().trim();
      const postId = ($el.attr('data-content') || '').replace('post-', '');
      const number = $el.find('ul.message-attribution-opposite a').last().text().trim();
      const $body = $el.find('.message-body .bbWrapper').first().clone();
      $body.find('blockquote').remove(); // цитаты не считаем
      const text = $body.text().replace(/\s+/g, ' ').trim();
      if (!author || !postId) return;
      posts.push({ postId, number, author, text, url: `https://${ALLOWED_HOST}/posts/${postId}/` });
    });

    let next = null;
    const href = $('a.pageNav-jump--next').first().attr('href');
    if (href) {
      const nu = parseUrl(new URL(href, u.origin).href);
      if (nu) next = nu.href;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ posts, next });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
