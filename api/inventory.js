import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default async function handler(req, res) {
  // CORS Headers - Pastikan Dashboard Localhost diizinkan akses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, target } = req.query;

  try {
    // --- ACTION: GET DATA (READ) ---
    if (req.method === 'GET' && action === 'get_data') {
      let sql = '';
      if (target === 'master') {
        // Query ini harus sama persis dengan kolom di image_bdf66e.png
        sql = 'SELECT loc, zone, aisle, unique_id, assign FROM master_lokasi ORDER BY loc ASC';
      } else if (target === 'recon') {
        sql = 'SELECT * FROM inventory_reconciliation ORDER BY location_id ASC';
      } else if (target === 'first') {
        sql = 'SELECT * FROM inventory_first ORDER BY timestamp DESC';
      } else if (target === 'second') {
        sql = 'SELECT * FROM inventory_second ORDER BY timestamp DESC';
      }

      if (!sql) throw new Error("Target data tidak valid");

      const result = await pool.query(sql);
      // PENTING: Kirim balik 'data' agar Frontend bisa membaca result.data.data
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    // --- ACTION: UPLOAD SNAPSHOT ---
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body;
      if (!data || !Array.isArray(data)) throw new Error("Format data Excel tidak valid");

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
        
        // Peringatan: Pastikan VIEW ini sudah ada di Neon Console Bos!
        await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    }

    // --- ACTION: ASSIGN LOKASI ---
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      
      // Refresh laporan setelah buka/tutup gembok
      try {
        await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      } catch (err) {
        console.warn("View recon belum dibuat, skip refresh.");
      }
      
      return res.status(200).json({ status: 'success' });
    }

  } catch (error) {
    console.error("DATABASE_ERROR:", error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
