const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Gunakan metode GET' });
  }

  let client;

  try {
    client = await pool.connect();

    // Mengambil data unik per picklist_number
    // Filter status: open OR partial picked
    const query = `
      SELECT 
        picklist_number, 
        nama_customer as customer_name, 
        SUM(qty_pick) as total_qty, 
        status_pick as status
      FROM picklist_raw 
      WHERE status_pick IN ('open', 'partial picked')
      GROUP BY picklist_number, nama_customer, status_pick
      ORDER BY picklist_number DESC
    `;

    const result = await client.query(query);

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
