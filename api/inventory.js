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
    // --- GET DATA ---
    if (req.method === 'GET' && action === 'get_data') {
      let sql = '';
      if (target === 'master') {
        // AMBIL SEMUA unique_id. Tidak pakai DISTINCT ON agar tidak ada data yang hilang di dashboard
        sql = 'SELECT unique_id, location_id, assign FROM master_lokasi ORDER BY location_id ASC, unique_id ASC';
      } else if (target === 'snapshot_list') {
        sql = 'SELECT * FROM view_snapshot_list ORDER BY location_id ASC';
      } else if (target === 'recon') {
        sql = 'SELECT * FROM inventory_reconciliation ORDER BY location_id ASC';
      } else {
        // Default untuk first dan second count
        sql = `SELECT * FROM inventory_${target === 'first' ? 'first' : 'second'} ORDER BY timestamp DESC`;
      }

      const result = await pool.query(sql);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    // --- ASSIGN LOKASI (PASTIKAN WHERE UNIQUE_ID) ---
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      // WAJIB nembak unique_id (Primary Key)
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      
      try { await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation'); } catch (e) {}
      return res.status(200).json({ status: 'success' });
    }

    // --- UPLOAD SNAPSHOT ---
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        for (const item of data) {
          await client.query(
            'INSERT INTO inventory_snap (location_id, artikel, qty_snap) VALUES ($1, $2, $3)',
            [String(item.location_id), String(item.artikel), parseInt(item.qty_snap) || 0]
          );
        }
        await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
