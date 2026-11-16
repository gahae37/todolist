// Vercel 서버리스 함수: 할 일 데이터를 Redis(Upstash)에 저장/불러오기
// 동기화 코드별로 데이터를 따로 저장함 (코드의 해시값이 저장 키). 환경변수: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash 연결 시 자동 생성)
const crypto = require('crypto');
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'server not configured' });
  const code = String(req.headers['x-sync-key'] || '');
  if (code.length < 8 || code.length > 100) return res.status(401).json({ error: 'bad key' });
  const KEY = `todo:${crypto.createHash('sha256').update(code).digest('hex')}`;

  try {
    const cur = JSON.parse((await redis('GET', KEY)) || 'null'); // { updatedAt, data } 또는 null

    if (req.method === 'GET') return res.status(200).json(cur || { updatedAt: 0, data: null });

    if (req.method === 'PUT') {
      const d = req.body && req.body.data;
      if (!d || !Array.isArray(d.categories) || !Array.isArray(d.todos)) return res.status(400).json({ error: 'bad data' });
      const updatedAt = Number(d.updatedAt) || 0;
      // 더 오래된 내용이 최신 내용을 덮어쓰지 못하게 막음
      if (cur && cur.updatedAt > updatedAt) return res.status(409).json(cur);
      const value = JSON.stringify({ updatedAt, data: d });
      await redis('SET', KEY, value);
      // 하루에 한 번 스냅샷을 30일간 보관 (실수로 지워도 복구 가능)
      const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      await redis('SET', `${KEY}:snapshot:${day}`, value, 'EX', 30 * 86400, 'NX');
      return res.status(200).json({ ok: true, updatedAt });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'storage error' });
  }
};
