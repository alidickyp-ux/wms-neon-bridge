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
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, cache-control');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, target } = req.query;

  try {
    // ================= 1. LOGIN =================
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ status: 'failed', message: 'ISI USER & PASS' });

      const { rows } = await pool.query(
        `SELECT username, full_name, role FROM operators WHERE username = $1 AND password = $2`,
        [username.trim(), password.trim()]
      );

      if (rows.length === 0) return res.status(401).json({ status: 'failed', message: 'LOGIN GAGAL' });
      return res.status(200).json({ status: 'success', user: rows[0] });
    }

    // ================= 2. GET DATA =================
    if (action === 'get_data' && req.method === 'GET') {
      // ── PRODUCT DESC ──
      if (target === 'product_desc') {
        const productId = req.query.product_id;
        if (!productId) return res.json({ status: 'error', description: null });
        const { rows } = await pool.query(
          `SELECT description FROM master_product WHERE product_id = $1 LIMIT 1`,
          [productId.trim().toUpperCase()]
        );
        return res.json({ status: 'success', description: rows.length > 0 ? rows[0].description : null });
      }

      // ── LOCATION ITEMS (Untuk Android - Tetap Ada & Tidak Berubah) ──
      if (target === 'location_items') {
        const loc = req.query.location_id;
        if (!loc) return res.status(400).json({ status: 'error', message: 'location_id wajib' });

        const { rows: snapRows } = await pool.query(
          `SELECT s.location_id, s.artikel, s.qty_snap, p.description, 'snap' AS source
           FROM inventory_snap s
           LEFT JOIN master_product p ON s.artikel = p.product_id
           WHERE UPPER(TRIM(s.location_id)) = UPPER(TRIM($1))
           ORDER BY s.artikel ASC`, [loc]
        );

        const { rows: reconRows } = await pool.query(
          `SELECT r.location_id, r.artikel, COALESCE(r.qty_snap, 0) AS qty_snap,
                  p.description, r.final_status, r.qty_1st, r.qty_2nd, 'recon' AS source
           FROM inventory_reconciliation r
           LEFT JOIN master_product p ON r.artikel = p.product_id
           WHERE UPPER(TRIM(r.location_id)) = UPPER(TRIM($1))
             AND (r.artikel IS NOT NULL AND r.artikel <> '')
             AND NOT EXISTS (
               SELECT 1 FROM inventory_snap s
               WHERE UPPER(TRIM(s.location_id)) = UPPER(TRIM($1))
                 AND UPPER(TRIM(s.artikel)) = UPPER(TRIM(r.artikel))
             )
           ORDER BY r.artikel ASC`, [loc]
        );

        const combined = [...snapRows, ...reconRows];
        return res.json({ status: combined.length > 0 ? 'success' : 'empty', data: combined });
      }

      // ── QUERY MAP (Master, All, Snap, First, Second, Recon) ──
      const map = {
        master: `SELECT DISTINCT ON (unique_id) unique_id, location_id, assign FROM master_lokasi ORDER BY unique_id ASC`,
        master_all: `SELECT location_id, zone, aisle, unique_id, assign FROM master_lokasi ORDER BY location_id ASC`,
        snapshot_list: `SELECT s.location_id, s.artikel, s.qty_snap, p.description FROM inventory_snap s LEFT JOIN master_product p ON s.artikel = p.product_id ORDER BY s.location_id ASC`,
        first: `SELECT * FROM inventory_first ORDER BY timestamp DESC`,
        second: `SELECT * FROM inventory_second ORDER BY timestamp DESC`,
        recon: `SELECT * FROM inventory_reconciliation ORDER BY location_id ASC`,
        picking_compliance: `SELECT * FROM picking_compliance ORDER BY created_at DESC`,
      };

      const sql = map[target];
      if (!sql) return res.json({ status: 'error', message: 'Target not found' });
      const { rows } = await pool.query(sql);
      return res.json({ status: 'success', data: rows });
    }

    // ================= 3. UPLOAD SNAPSHOT =================
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        for (const item of data) {
          const loc = String(item.location_id ?? item.LOCATION ?? '').trim().toUpperCase();
          const artRaw = String(item.artikel ?? item.ARTICLE ?? '').trim().toUpperCase();
          const art = (artRaw === '' || artRaw === '0') ? '-' : artRaw;
          const qty = parseInt(item.qty_snap ?? item.QTY ?? 0) || 0;
          if (loc) await client.query(`INSERT INTO inventory_snap (location_id, artikel, qty_snap) VALUES ($1, $2, $3)`, [loc, art, qty]);
        }
        try { await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    // ================= 4. MANAJEMEN MASTER LOKASI (FIXED & IMPROVED) =================
    
    // ADD / UPDATE LOCATION
    if (action === 'add_location' && req.method === 'POST') {
      const { location_id, zone, aisle, unique } = req.body;
      const locId = String(location_id || '').trim().toUpperCase();
      const uid = unique || `${zone}-${aisle}`;
      
      if (!locId) return res.status(400).json({ status: 'error', message: 'ID Kosong' });

      await pool.query(
        `INSERT INTO master_lokasi (location_id, zone, aisle, unique_id, assign) 
         VALUES ($1, $2, $3, $4, 'closed')
         ON CONFLICT (location_id) DO UPDATE SET zone = EXCLUDED.zone, aisle = EXCLUDED.aisle, unique_id = EXCLUDED.unique_id`,
        [locId, zone, aisle, uid]
      );
      return res.json({ status: 'success' });
    }

    // DELETE LOCATION
    if (action === 'delete_location' && req.method === 'POST') {
      const { unique_id } = req.body;
      // Menghapus berdasarkan unique_id atau location_id untuk fleksibilitas
      await pool.query(`DELETE FROM master_lokasi WHERE unique_id = $1 OR location_id = $1`, [unique_id]);
      return res.json({ status: 'success' });
    }

    // IMPORT MASTER DATA (EXCEL - Menggunakan Upsert agar data Sinkron)
    if (action === 'upload_master' && req.method === 'POST') {
      const { data } = req.body;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of data) {
          const loc = String(item.location_id || item.LOCATION || '').trim().toUpperCase();
          const zone = String(item.zone || item.ZONE || '').trim().toUpperCase();
          const aisle = String(item.aisle || item.AISLE || '').trim();
          const uid = item.unique_id || `${zone}-${aisle}`;
          
          if (loc) {
            await client.query(
              `INSERT INTO master_lokasi (location_id, zone, aisle, unique_id, assign) 
               VALUES ($1, $2, $3, $4, 'closed')
               ON CONFLICT (location_id) DO UPDATE SET zone = EXCLUDED.zone, aisle = EXCLUDED.aisle, unique_id = EXCLUDED.unique_id`,
              [loc, zone, aisle, uid]
            );
          }
        }
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    //cek location//
    if (action === 'check_location_status' && req.method === 'GET') {
  const loc = String(req.query.location_id || '').trim().toUpperCase();
  if (!loc) return res.json({ status: 'error', message: 'location_id kosong' });

  const { rows } = await pool.query(
    `SELECT artikel, qty_snap, qty_1st, qty_2nd, final_status
     FROM inventory_reconciliation
     WHERE UPPER(TRIM(location_id)) = UPPER(TRIM($1))
     ORDER BY artikel ASC`,
    [loc]
  );

  if (rows.length === 0) {
    return res.json({ status: 'empty', data: [] });
  }

  return res.json({
    status: 'success',
    data: rows
  });
}


    // ================= 5. SAVE COUNT & ASSIGN =================
    if (action === 'save_input' && req.method === 'POST') {
  const { location_id, artikel, qty, operator, target_table } = req.body;

  const table = target_table?.includes('1st') ? 'inventory_first' : 'inventory_second';
  const colQty = target_table?.includes('1st') ? 'qty_1st' : 'qty_2nd';

  try {
    await pool.query(
      `INSERT INTO ${table} (location_id, artikel, ${colQty}, operator, timestamp)
       VALUES ($1, $2, $3, $4, NOW())`,
      [location_id, artikel, qty, operator]
    );
  } catch (e) {
    // 23505 = duplicate key (SKU sudah pernah diinput)
    if (e.code === '23505') {
      return res.json({
        status: 'failed',
        message: 'SKU SUDAH PERNAH DIINPUT, TIDAK BISA DIUBAH LAGI'
      });
    }
    throw e;
  }

  try { 
    await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); 
  } catch (e) {}

  return res.json({ status: 'success' });
}


    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.status(200).json({ status: 'success' });
    }

    // ================= 6. CLEAR DATA =================
    if (action.startsWith('clear_') && req.method === 'POST') {
      const table = { clear_snap: 'inventory_snap', clear_first: 'inventory_first', clear_second: 'inventory_second' }[action];
      if (table) {
        await pool.query(`TRUNCATE TABLE ${table}`);
        try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
        return res.json({ status: 'success' });
      }
    }

    return res.status(404).json({ error: 'ACTION NOT FOUND' });

  } catch (err) {
    console.error('CRITICAL API ERROR', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
