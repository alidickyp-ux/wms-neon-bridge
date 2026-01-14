
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  // Header CORS agar bisa diakses dari aplikasi luar
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Gunakan metode GET' });
  }

  let client;

// ... kode pool tetap sama ...

  try {
    const { picklist_number } = req.query;
    client = await pool.connect();

    // PERBAIKAN: Ganti nama tabel menjadi picklist_raw
    // Tambahkan filter status = 'open' agar hanya yang belum diproses yang muncul
    let query = `SELECT no_picklist as picklist_number, customer_name, total_qty, status_pick as status 
                 FROM picklist_raw 
                 WHERE status_pick = 'open'`;
    let values = [];

    if (picklist_number) {
      query += ` AND no_picklist = $1`;
      values.push(picklist_number);
    }

    const result = await client.query(query, values);

    return res.status(200).json({
      status: 'success',
      total_items: result.rowCount,
      data: result.rows
    });
    
// ... sisanya tetap sama ...

  } catch (err) {
    console.error("Database Error:", err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
