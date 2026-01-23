import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// PENTING: Supaya Neon bisa jalan di environment Node.js Vercel
neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default async function handler(req, res) {
  // 1. CORS Headers (Agar Dashboard lancar akses API)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // --- ACTION: UPLOAD SNAPSHOT ---
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body; 
      if (!data || !Array.isArray(data)) throw new Error("Data tidak valid");

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        
        // Optimasi: Insert sekaligus banyak (Batch Insert) agar tidak timeout
        const values = data.map(item => `('${item.location_id}', '${item.artikel}', ${item.qty_snap})`).join(',');
        const query = `INSERT INTO inventory_snap (location_id, artikel, qty_snap) VALUES ${values}`;
        
        await client.query(query);
        
        // Refresh View (Pastikan View ini sudah di-CREATE di Neon)
        await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        await client.query('COMMIT');
        
        return res.status(200).json({ status: 'success', message: 'Snapshot berhasil diperbarui' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    // --- ACTION: ASSIGN LOKASI (OPEN/CLOSE) ---
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body;
      
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      // Update laporan recon setelah status berubah
      await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      
      return res.status(200).json({ status: 'success', message: `Status ${unique_id} diubah ke ${status}` });
    }

    // --- ACTION: GET DATA (READ ONLY) ---
    if (action === 'get_data' && req.method === 'GET') {
      const { target } = req.query;
      let sql = '';

      // Map target ke query SQL (Pastikan nama tabel sama persis di Neon)
      const queryMap = {
        'master': 'SELECT * FROM master_lokasi ORDER BY loc ASC',
        'recon': 'SELECT * FROM inventory_reconciliation ORDER BY location_id ASC',
        'first': 'SELECT * FROM inventory_first ORDER BY timestamp DESC',
        'second': 'SELECT * FROM inventory_second ORDER BY timestamp DESC'
      };

      sql = queryMap[target];
      if (!sql) return res.status(400).json({ error: 'Target data tidak ditemukan' });

      const result = await pool.query(sql);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    return res.status(400).json({ error: 'Action tidak dikenal' });

  } catch (error) {
    console.error("INVENTORY_API_ERROR:", error.message);
    // Kirim pesan error yang lebih detail ke Front-end agar Bos gampang ceknya
    return res.status(500).json({ 
      status: 'error', 
      message: error.message,
      tip: "Cek apakah tabel/view sudah ada di Neon Console." 
    });
  }
}
