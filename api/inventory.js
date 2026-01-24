import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// PENTING: Supaya Neon jalan lancar di serverless Vercel
neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, target } = req.query;

  try {
    // --- ACTION: AMBIL DATA (GET) ---
    if (req.method === 'GET' && action === 'get_data') {
      let sql = '';
      if (target === 'master') {
        sql = 'SELECT loc, zone, aisle, unique_id, assign FROM master_lokasi ORDER BY loc ASC';
      } else if (target === 'recon') {
        sql = 'SELECT * FROM inventory_reconciliation ORDER BY location_id ASC';
      } else if (target === 'first') {
        sql = 'SELECT * FROM inventory_first ORDER BY timestamp DESC';
      } else if (target === 'second') {
        sql = 'SELECT * FROM inventory_second ORDER BY timestamp DESC';
      }

      const result = await pool.query(sql);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    // --- ACTION: UPLOAD SNAPSHOT (POST) ---
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      if (!data || !Array.isArray(data)) throw new Error("Data tidak valid");

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        
        // Batch Insert: Mengolah data dari Excel
        for (const item of data) {
          await client.query(
            'INSERT INTO inventory_snap (location_id, artikel, qty_snap) VALUES ($1, $2, $3)',
            [String(item.location_id), String(item.artikel), parseInt(item.qty_snap) || 0]
          );
        }
        
        await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    }

    // --- ACTION: ASSIGN LOKASI (POST) ---
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      return res.status(200).json({ status: 'success' });
    }

  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
