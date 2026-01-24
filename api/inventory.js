import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

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
    // --- ACTION: GET DATA ---
    if (req.method === 'GET' && action === 'get_data') {
      let sql = '';
      
      // Gunakan location_id sebagai kunci utama yang konsisten
      if (target === 'master') {
        sql = 'SELECT DISTINCT ON (location_id) location_id, assign FROM master_lokasi ORDER BY location_id ASC';
      } else if (target === 'snapshot_list') {
        sql = 'SELECT * FROM view_snapshot_list ORDER BY location_id ASC';
      } else if (target === 'recon') {
        sql = 'SELECT * FROM inventory_reconciliation ORDER BY location_id ASC';
      } else if (target === 'first') {
        sql = 'SELECT * FROM inventory_first ORDER BY timestamp DESC';
      } else if (target === 'second') {
        sql = 'SELECT * FROM inventory_second ORDER BY timestamp DESC';
      }

      if (!sql) return res.status(400).json({ error: 'Target tidak dikenal' });

      const result = await pool.query(sql);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    // --- ACTION: ASSIGN LOKASI (PEMANTIK) ---
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body; // unique_id di sini adalah location_id dari frontend
      
      // Update status di master_lokasi
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE location_id = $2', [status, unique_id]);
      
      // Refresh View Rekonsiliasi
      try {
        await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      } catch (e) {
        console.log("View belum ada, skipping refresh");
      }
      
      return res.status(200).json({ status: 'success' });
    }

    // --- ACTION: UPLOAD SNAPSHOT ---
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
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

  } catch (error) {
    console.error("ERROR_LOG:", error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
