import { Pool } from 'pg';

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function warmup() {
  await pool.query('SELECT 1');
}

export default async function handler(req, res) {
  // ================= NO CACHE =================
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // ================= CORS =================
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;

  try {
    await warmup();

    // ================= LOGIN =================// ================= LOGIN =================
if (action === 'login' && req.method === 'POST') {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      status: 'failed',
      message: 'USERNAME / PASSWORD KOSONG',
    });
  }

  const { rows } = await pool.query(
    `
    SELECT username, name, role
    FROM operators
    WHERE username = $1
      AND password = $2
      AND status = 'active'
    `,
    [username.trim(), password.trim()]
  );

  if (rows.length === 0) {
    return res.status(401).json({
      status: 'failed',
      message: 'LOGIN GAGAL',
    });
  }

  return res.status(200).json({
    status: 'success',
    user: rows[0],
  });
}


    // ================= GET DATA =================
    if (action === 'get_data' && req.method === 'GET') {
      const map = {
        master: `SELECT * FROM master_lokasi ORDER BY unique_id`,
        snapshot_list: `SELECT * FROM snapshot`,
        first: `SELECT * FROM count_1st`,
        second: `SELECT * FROM count_2nd`,
        recon: `
          SELECT location_id, artikel, qty_snap, qty_1st, qty_2nd, final_status
          FROM reconciliation_view
        `,
      };

      const sql = map[req.query.target];
      if (!sql) return res.json({ data: [] });

      const { rows } = await pool.query(sql);
      return res.json({ data: rows });
    }

    // ================= UPLOAD SNAPSHOT =================
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'INVALID DATA' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const r of data) {
          const loc = String(r.LOCATION || r.location_id || '').trim().toUpperCase();
          const art = String(r.ARTICLE || r.artikel || '').trim().toUpperCase();
          const qty = Number(r.QTY || r.qty_snap || 0);

          if (!loc || !art) continue;

          await client.query(
            `
            INSERT INTO snapshot (location_id, artikel, qty_snap)
            VALUES ($1,$2,$3)
            ON CONFLICT (location_id, artikel)
            DO UPDATE SET qty_snap = EXCLUDED.qty_snap
            `,
            [loc, art, qty]
          );
        }

        await client.query('COMMIT');
        return res.json({ status: 'success', rows: data.length });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        return res.status(500).json({ error: 'UPLOAD FAILED' });
      } finally {
        client.release();
      }
    }

    // ================= SAVE COUNT =================
    if (action === 'save_input' && req.method === 'POST') {
      const { location_id, artikel, qty, operator, target_table } = req.body;

      const table =
        target_table === '1st Count'
          ? 'count_1st'
          : target_table === '2nt Count'
          ? 'count_2nd'
          : null;

      if (!table) return res.status(400).json({ error: 'INVALID TARGET' });

      await pool.query(
        `
        INSERT INTO ${table} (location_id, artikel, qty, operator)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (location_id, artikel)
        DO UPDATE SET qty = EXCLUDED.qty, operator = EXCLUDED.operator
        `,
        [location_id, artikel, qty, operator]
      );

      return res.json({ status: 'saved' });
    }

    // ================= CLEAR =================
    if (req.method === 'POST') {
      const map = {
        clear_snap: 'snapshot',
        clear_first: 'count_1st',
        clear_second: 'count_2nd',
      };

      if (map[action]) {
        await pool.query(`TRUNCATE ${map[action]}`);
        return res.json({ status: 'cleared' });
      }
    }

    return res.status(404).json({ error: 'NOT FOUND' });
  } catch (err) {
    console.error('API ERROR', err);
    return res.status(500).json({ error: 'SERVER ERROR' });
  }
}
