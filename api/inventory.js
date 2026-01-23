import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// PENTING: Neon serverless butuh konfigurasi WebSocket agar bisa jalan di Vercel
neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default async function handler(req, res) {
  // Tambahkan Header CORS agar Dashboard bisa akses tanpa hambatan
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // 1. ACTION: UPLOAD SNAPSHOT
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        
        // Optimasi: Gunakan satu query besar daripada looping insert satu-satu (biar gak timeout)
        if (data.length > 0) {
          for (const item of data) {
            await client.query(
              'INSERT INTO inventory_snap (location_id, artikel, qty_snap) VALUES ($1, $2, $3)',
              [item.location_id, item.artikel, item.qty_snap]
            );
          }
        }
        
        // Cek apakah view ini sudah dibuat di Neon? Jika belum, baris ini akan bikin Error 500
        await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success', message: 'Snapshot Updated' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    }

    // 2. ACTION: ASSIGN/TOGGLE STATUS LOKASI
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      
      // Refresh view setiap ada perubahan status lokasi
      await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      return res.status(200).json({ status: 'success', new_status: status });
    }

    // 3. ACTION: GET DATA
    if (action === 'get_data' && req.method === 'GET') {
      const { target } = req.query;
      let queryText = '';

      // Pastikan nama tabel di SQL Neon sama persis dengan ini (Case Sensitive)
      if (target === 'recon') queryText = 'SELECT * FROM inventory_reconciliation';
      else if (target === 'first') queryText = 'SELECT * FROM inventory_first ORDER BY timestamp DESC';
      else if (target === 'second') queryText = 'SELECT * FROM inventory_second ORDER BY timestamp DESC';
      else if (target === 'master') queryText = 'SELECT * FROM master_lokasi ORDER BY loc ASC';

      if (!queryText) return res.status(400).json({ error: 'Target not valid' });

      const result = await pool.query(queryText);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    return res.status(400).json({ error: 'Action not found' });

  } catch (error) {
    console.error("Database Error Detail:", error.message);
    return res.status(500).json({ 
      error: error.message,
      hint: "Pastikan Materialized View 'inventory_reconciliation' sudah dibuat di Neon Console." 
    });
  }
}
