const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const { 
    picklist_number, 
    product_id, 
    qty_packed, 
    container_number, 
    container_type, 
    packer_name 
  } = req.body;

  // Validasi input dasar
  if (!picklist_number || !product_id || !qty_packed || !container_number) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let client;
  try {
    client = await pool.connect();

    // 1. GENERATE HUID (Contoh: HUID-PCB23-1712345678)
    const timestamp = Date.now();
    const huid = `HUID-${picklist_number}-${timestamp}`;

    // 2. INSERT ke packing_transactions
    // Status diset 'open' karena masih masuk ke "Laci Packing"
    const query = `
      INSERT INTO packing_transactions (
        picklist_number, 
        product_id, 
        qty_packed, 
        container_number, 
        container_type, 
        huid, 
        packer_name, 
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
      RETURNING id, huid;
    `;

    const result = await client.query(query, [
      picklist_number, 
      product_id, 
      qty_packed, 
      container_number, 
      container_type, 
      huid, 
      packer_name
    ]);

    return res.status(200).json({
      status: 'success',
      message: "Data masuk ke Laci Packing",
      data: result.rows[0]
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
