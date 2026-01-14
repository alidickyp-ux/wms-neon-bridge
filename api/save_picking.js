const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { 
    picklist_number, 
    product_id, 
    location_id, 
    qty_actual, 
    picker_name, 
    description 
  } = req.body;

  // Log data yang masuk untuk debugging di Vercel Log
  console.log("Data diterima:", req.body);

  let client;
  try {
    client = await pool.connect();
    
    // Pastikan nama kolom sesuai dengan header di database Neon Anda
    const query = `
      INSERT INTO picking_transactions (
        picklist_number, 
        product_id, 
        location_id, 
        qty_actual, 
        picker_name, 
        description,
        scanned_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id;
    `;

    const values = [
      picklist_number || 'NA', 
      product_id, 
      location_id, 
      parseInt(qty_actual) || 0, 
      picker_name || 'Android_User', 
      description || ''
    ];

    const result = await client.query(query, values);
    console.log("Insert Berhasil, ID:", result.rows[0].id);

    return res.status(201).json({
      status: 'success',
      message: 'Data berhasil masuk ke Neon',
      id: result.rows[0].id
    });

  } catch (err) {
    console.error("Database Error:", err.message);
    return res.status(500).json({ 
      status: 'error', 
      message: "Gagal ke database: " + err.message 
    });
  } finally {
    if (client) client.release();
  }
};
