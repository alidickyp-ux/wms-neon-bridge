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
    // --- 1. LOGIN ---
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body;
      const result = await pool.query(
        "SELECT id, username, full_name, role FROM operators WHERE username = $1 AND password = $2",
        [username, password]
      );
      if (result.rows.length > 0) return res.status(200).json({ status: 'success', user: result.rows[0] });
      return res.status(401).json({ status: 'error', message: 'Username/Password salah' });
    }

    // --- 2. GET DATA ---
    if (req.method === 'GET' && action === 'get_data') {
      let sql = '';
      if (target === 'master') {
        sql = 'SELECT unique_id, assign, location_id FROM master_lokasi ORDER BY location_id ASC';
      } else if (target === 'snapshot_list') {
        sql = 'SELECT location_id, artikel, qty_snap FROM inventory_snap ORDER BY location_id ASC';
      } else if (target === 'recon') {
        sql = 'SELECT * FROM inventory_reconciliation ORDER BY location_id ASC';
      } else {
        const tableSuffix = target === 'first' ? 'first' : 'second';
        sql = `SELECT * FROM inventory_${tableSuffix} ORDER BY timestamp DESC`;
      }
      const result = await pool.query(sql);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    // --- 3. SAVE INPUT (1ST & 2ND) ---
    if (action === 'save_input' && req.method === 'POST') {
      const { location_id, artikel, qty, operator, target_table } = req.body;
      const table = target_table.includes('1st') ? 'inventory_first' : 'inventory_second';
      const colQty = target_table.includes('1st') ? 'qty_1st' : 'qty_2nd';

      const sql = `
        INSERT INTO ${table} (location_id, artikel, ${colQty}, operator, timestamp)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (location_id, artikel)
        DO UPDATE SET ${colQty} = EXCLUDED.${colQty}, timestamp = NOW()
      `;
      await pool.query(sql, [location_id, artikel, qty, operator]);
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.status(200).json({ status: 'success' });
    }

    // --- 4. UPLOAD SNAPSHOT (CLEAN: NO DESCRIPTION) ---
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        for (const item of data) {
          await client.query(
            "INSERT INTO inventory_snap (location_id, artikel, qty_snap) VALUES ($1, $2, $3)",
            [
              String(item.location_id || ''), 
              String(item.artikel || ''), 
              parseInt(item.qty_snap) || 0
            ]
          );
        }
        try { await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      } catch (e) { 
        await client.query('ROLLBACK'); 
        throw e; 
      } finally { client.release(); }
    }

    // --- 5. CLEAR DATA ---
    const clearActions = ['clear_snap', 'clear_first', 'clear_second'];
    if (req.method === 'POST' && clearActions.includes(action)) {
      let tableName = action === 'clear_snap' ? 'inventory_snap' : 
                      (action === 'clear_first' ? 'inventory_first' : 'inventory_second');
      await pool.query(`TRUNCATE TABLE ${tableName}`);
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.status(200).json({ status: 'success' });
    }

    // --- 6. ASSIGN LOKASI ---
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.status(200).json({ status: 'success' });
    }

  } catch (error) {
    console.error("API_ERROR:", error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
