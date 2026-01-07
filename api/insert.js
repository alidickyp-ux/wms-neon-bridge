const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;

  if (req.method === 'GET') {
    try {
      client = await pool.connect();
      
      // Menggunakan picklist_number sebagai kunci pencarian
      const { picklist_number } = req.query; 

      if (picklist_number) {
        // AMBIL DETAIL: Berdasarkan picklist_number
        const result = await client.query(
          "SELECT product_id, location_id, qty_pick, nama_customer FROM picklist_final WHERE picklist_number = $1",
          [picklist_number]
        );
        return res.status(200).json(result.rows);
      } else {
        // AMBIL LIST: Semua picklist_number yang unik dan status 'open'
        const result = await client.query(
          "SELECT DISTINCT picklist_number FROM picklist_final WHERE status = 'open' ORDER BY picklist_number ASC"
        );
        const listNo = result.rows.map(row => row.picklist_number);
        return res.status(200).json(listNo);
      }
    } catch (err) {
      return res.status(500).json({ status: 'error', message: err.message });
    } finally {
      if (client) client.release();
    }
  }

  // --- LOGIKA POST TETAP SAMA ---
  if (req.method === 'POST') {
    // ... kode POST Anda sudah benar ...
  }
};
