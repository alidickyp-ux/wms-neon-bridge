import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, target } = req.query;

  try {
    // --- 1. ACTION: GET DATA (DENGAN DESCRIPTION) ---
    if (req.method === 'GET' && action === 'get_data') {
      let sql = '';
      if (target === 'master') {
        sql = 'SELECT DISTINCT ON (unique_id) unique_id, assign FROM master_lokasi ORDER BY unique_id ASC';
      } else if (target === 'snapshot_list') {
        // Ambil langsung dari tabel agar kolom description terbawa
        sql = 'SELECT location_id, artikel, qty_snap, description FROM inventory_snap ORDER BY location_id ASC';
      } else if (target === 'recon') {
        sql = 'SELECT * FROM inventory_reconciliation ORDER BY location_id ASC';
      } else {
        sql = `SELECT * FROM inventory_${target === 'first' ? 'first' : 'second'} ORDER BY timestamp DESC`;
      }
      const result = await pool.query(sql);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    // --- 2. ACTION: SAVE INPUT (KHUSUS DARI HP) ---
    if (action === 'save_input' && req.method === 'POST') {
      const { location_id, artikel, qty, operator, target_table } = req.body;
      const table = target_table === '1st Count' ? 'inventory_first' : 'inventory_second';
      
      const sql = `
        INSERT INTO ${table} (location_id, artikel, qty, operator, timestamp)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (location_id, artikel)
        DO UPDATE SET qty = EXCLUDED.qty, timestamp = NOW()
      `;
      await pool.query(sql, [location_id, artikel, qty, operator]);
      
      // Paksa refresh view agar dashboard PC langsung update
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      
      return res.status(200).json({ status: 'success', message: 'Data Berhasil Disimpan' });
    }

    // --- 3. ACTION: UPLOAD SNAPSHOT ---
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        for (const item of data) {
          await client.query(
            `INSERT INTO inventory_snap (location_id, artikel, qty_snap) 
             VALUES ($1, $2, $3)
             ON CONFLICT (location_id, artikel) 
             DO UPDATE SET qty_snap = inventory_snap.qty_snap + EXCLUDED.qty_snap`,
            [String(item.location_id), String(item.artikel), parseInt(item.qty_snap) || 0]
          );
        }
        await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }

    // --- 4. ACTION: ASSIGN LOKASI ---
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.status(200).json({ status: 'success' });
    }

    // --- 5. ACTION: LOGIN ---
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body;
      const result = await pool.query('SELECT id, username, full_name, role FROM operators WHERE username = $1 AND password = $2', [username, password]);
      if (result.rows.length > 0) return res.status(200).json({ status: 'success', user: result.rows[0] });
      return res.status(401).json({ status: 'error', message: 'Salah User/Pass' });
    }

  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
