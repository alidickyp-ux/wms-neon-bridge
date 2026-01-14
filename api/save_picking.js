const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  // Hanya izinkan metode POST
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

  let client;
  try {
    client = await pool.connect();
    
    // Query untuk insert data ke picking_transactions
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

    const values = [picklist_number, product_id, location_id, qty_actual, picker_name, description];
    const result = await client.query(query, values);

    return res.status(201).json({
      status: 'success',
      message: 'Data picking berhasil disimpan',
      transaction_id: result.rows[0].id
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
