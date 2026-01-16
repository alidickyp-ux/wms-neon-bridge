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

  if (!picklist_number || !product_id || !qty_packed || !container_number) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let client;
  try {
    client = await pool.connect();

    // --- LOGIKA HUID BARU ---
    // 1. Ambil 5 angka terakhir dari Picklist Number
    const pcbSuffix = picklist_number.slice(-5);

    // 2. Ambil Tanggal format DDMMYY
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear()).slice(-2);
    const dateStr = `${day}${month}${year}`;

    // 3. Generate Random String (3 Karakter)
    const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();

    // GABUNGKAN: 00123 + 160126 + ABC
    const huid = `${pcbSuffix}${dateStr}${randomStr}`;
    // -----------------------

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
      huid_generated: huid,
      data: result.rows[0]
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
