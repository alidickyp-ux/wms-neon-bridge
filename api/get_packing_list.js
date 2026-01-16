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
        status_picklist,
        COUNT(product_id) as total_sku,
        SUM(qty_real) as total_pcs_picked
      FROM picklist_raw 
      WHERE status IN ('PARTIAL PICKED', 'FULLY PICKED')
      GROUP BY picklist_number, nama_customer, status_picklist
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
