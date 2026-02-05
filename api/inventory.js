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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, cache-control');

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

// ================= 2. GET DATA (LOOKUP KE MASTER PRODUCT) =================
if (action === 'get_data' && req.method === 'GET') {
  const map = {
    master: `
      SELECT DISTINCT ON (unique_id) 
        unique_id, 
        location_id, 
        assign 
      FROM master_lokasi 
      ORDER BY unique_id ASC
    `,
    /**
     * FIX: Mengambil deskripsi dari tabel master_product.
     * s.artikel dicocokkan dengan p.product_id.
     * LEFT JOIN digunakan agar jika artikel belum terdaftar di master_product, 
     * data snapshot tetap muncul (deskripsi akan berisi null/-).
     */
    snapshot_list: `
      SELECT 
        s.location_id, 
        s.artikel, 
        s.qty_snap, 
        p.description 
      FROM inventory_snap s
      LEFT JOIN master_product p ON s.artikel = p.product_id
      ORDER BY s.location_id ASC
    `,
    first: `SELECT * FROM inventory_first ORDER BY timestamp DESC`,
    second: `SELECT * FROM inventory_second ORDER BY timestamp DESC`,
    recon: `SELECT * FROM inventory_reconciliation ORDER BY location_id ASC`,
  };

  const sql = map[target];
  if (!sql) return res.json({ data: [] });

  const { rows } = await pool.query(sql);
  return res.json({ status: 'success', data: rows });
}

    // --- 4. ACTION: UPLOAD SNAPSHOT (BATCH MODE - FIXED COLUMN COUNT) ---
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      if (!data || !Array.isArray(data)) {
        return res.status(400).json({ status: 'error', message: 'Data tidak valid' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        
        const summaryMap = {};
        for (const item of data) {
          const loc = String(item.location_id || item.LOCATION || '').trim().toUpperCase();
          const art = String(item.artikel || item.ARTICLE || '').trim().toUpperCase();
          const qty = parseInt(item.qty_snap || item.QTY || 0);

          if (!loc || !art) continue;

          const key = `${loc}|${art}`;
          if (summaryMap[key]) {
            summaryMap[key].qty += qty;
          } else {
            summaryMap[key] = { loc, art, qty };
          }
        }

        const finalValues = Object.values(summaryMap);
        if (finalValues.length > 0) {
          const values = [];
          const placeholders = [];
          let counter = 1;

          for (const item of finalValues) {
            values.push(item.loc, item.art, item.qty);
            // Counter kembali ke 3 karena upload Ali hanya kirim 3 kolom
            placeholders.push(`($${counter}, $${counter + 1}, $${counter + 2})`);
            counter += 3;
          }

          /**
           * FIX: Query INSERT kembali ke 3 kolom (location_id, artikel, qty_snap)
           * Deskripsi tidak di-insert karena Ali ingin Lookup dari tabel lain
           */
          const batchSql = `
            INSERT INTO inventory_snap (location_id, artikel, qty_snap) 
            VALUES ${placeholders.join(', ')}
            ON CONFLICT (location_id, artikel) 
            DO UPDATE SET qty_snap = EXCLUDED.qty_snap
          `;
          await client.query(batchSql, values);
        }
        
        try { await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success', total: finalValues.length });
      } catch (e) { 
        await client.query('ROLLBACK'); 
        console.error("FIXED_BATCH_ERROR:", e.message);
        return res.status(500).json({ status: 'error', message: e.message });
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
