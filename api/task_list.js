
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

  try {
    // Mengambil parameter opsional 'picklist_number' jika ingin memfilter
    const { picklist_number } = req.query;
    
    client = await pool.connect();

    let query = `SELECT * FROM task_list_operator`;
    let values = [];

    // Jika operator ingin melihat picklist spesifik saja
    if (picklist_number) {
      query += ` WHERE picklist_number = $1`;
      values.push(picklist_number);
    }

    const result = await client.query(query, values);

    // Berikan respons data
    return res.status(200).json({
      status: 'success',
      total_items: result.rowCount,
      data: result.rows
    });

  } catch (err) {
    console.error("Database Error:", err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
