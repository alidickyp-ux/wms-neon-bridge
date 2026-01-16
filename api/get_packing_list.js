const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    // Query untuk mengambil PCB dengan status Partial atau Fully Picked
    // Kita gunakan DISTINCT agar nomor PCB tidak duplikat di daftar
    const query = `
      SELECT 
        picklist_number, 
        nama_customer, 
        status AS status_picklist,
        COUNT(product_id)::int AS total_sku,
        COALESCE(SUM(qty_actual), 0)::int AS total_pcs_picked
      FROM picklist_raw 
      WHERE LOWER(status) IN ('partial picked', 'fully picked')
      GROUP BY picklist_number, nama_customer, status
      ORDER BY picklist_number DESC
    `;

    const result = await client.query(query);

    return res.status(200).json({
      status: 'success',
      total_data: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
