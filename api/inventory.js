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

export default async function handler(req, res) {
  // --- Header No Cache & CORS ---
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, target } = req.query;

  try {
    // ================= 1. LOGIN (Sesuai Tabel operators) =================
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ status: 'failed', message: 'ISI USER & PASS' });
      }

      // Sesuaikan query dengan kolom full_name (bukan name)
      const { rows } = await pool.query(
        `SELECT username, full_name, role FROM operators 
         WHERE username = $1 AND password = $2`,
        [username.trim(), password.trim()]
      );

      if (rows.length === 0) {
        return res.status(401).json({ status: 'failed', message: 'LOGIN GAGAL' });
      }

      return res.status(200).json({ status: 'success', user: rows[0] });
    }

    // ================= 2. GET DATA (Sesuai Tabel Inventory) =================
// ================= 2. GET DATA (CLEAN: NO DUPLICATE) =================
    if (action === 'get_data' && req.method === 'GET') {
      const map = {
        // Gunakan DISTINCT ON agar unique_id tidak muncul dua kali
        master: `
          SELECT DISTINCT ON (unique_id) 
            unique_id, 
            location_id, 
            assign 
          FROM master_lokasi 
          ORDER BY unique_id ASC
        `,
        snapshot_list: `SELECT location_id, artikel, qty_snap FROM inventory_snap ORDER BY location_id ASC`,
        first: `SELECT * FROM inventory_first ORDER BY timestamp DESC`,
        second: `SELECT * FROM inventory_second ORDER BY timestamp DESC`,
        recon: `SELECT * FROM inventory_reconciliation ORDER BY location_id ASC`,
      };

      const sql = map[target];
      if (!sql) return res.json({ data: [] });

      const { rows } = await pool.query(sql);
      return res.json({ status: 'success', data: rows });
    }

    // ================= 3. UPLOAD SNAPSHOT (Sesuai Struktur Poin 4) =================
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      if (!Array.isArray(data)) return res.status(400).json({ error: 'INVALID DATA' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap'); // Bersihkan snap lama

        for (const r of data) {
          const loc = String(r.LOCATION || r.location_id || '').trim().toUpperCase();
          const art = String(r.ARTICLE || r.artikel || '').trim().toUpperCase();
          const qty = parseInt(r.QTY || r.qty_snap || 0);

          if (!loc || !art) continue;

          await client.query(
            `INSERT INTO inventory_snap (location_id, artikel, qty_snap)
             VALUES ($1, $2, $3)
             ON CONFLICT (location_id, artikel) DO UPDATE SET qty_snap = EXCLUDED.qty_snap`,
            [loc, art, qty]
          );
        }

        // Jalankan Refresh View agar Recon terupdate
        try { await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
        
        await client.query('COMMIT');
        return res.json({ status: 'success' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    }

    // ================= 4. SAVE COUNT (1st & 2nd) =================
    if (action === 'save_input' && req.method === 'POST') {
      const { location_id, artikel, qty, operator, target_table } = req.body;
      const isFirst = target_table.includes('1st');
      const table = isFirst ? 'inventory_first' : 'inventory_second';
      const colQty = isFirst ? 'qty_1st' : 'qty_2nd';

      await pool.query(
        `INSERT INTO ${table} (location_id, artikel, ${colQty}, operator, timestamp)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (location_id, artikel) 
         DO UPDATE SET ${colQty} = EXCLUDED.${colQty}, operator = EXCLUDED.operator, timestamp = NOW()`,
        [location_id, artikel, qty, operator]
      );

      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.json({ status: 'success' });
    }

    // ================= 5. CLEAR DATA (KOSONGKAN) =================
    if (req.method === 'POST') {
      const clearMap = {
        clear_snap: 'inventory_snap',
        clear_first: 'inventory_first',
        clear_second: 'inventory_second',
      };

      if (clearMap[action]) {
        await pool.query(`TRUNCATE TABLE ${clearMap[action]}`);
        try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
        return res.json({ status: 'success' });
      }
    }

    // ================= 6. ASSIGN LOCATION =================
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.status(200).json({ status: 'success' });
    }

    return res.status(404).json({ error: 'ACTION NOT FOUND' });
  } catch (err) {
    console.error('CRITICAL API ERROR', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
