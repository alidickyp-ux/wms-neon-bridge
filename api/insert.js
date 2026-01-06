const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Gunakan metode POST' });
  }

  let client;

  try {
    const { data } = req.body;
    if (!data || !Array.isArray(data)) {
      throw new Error("Format data tidak valid");
    }

    client = await pool.connect();

    // Query untuk 9 kolom (Termasuk sort_order)
    const query = `
      INSERT INTO picklist (
        sort_order, picklist_number, date_picklist, customer, 
        customer_name, product_id, location_id, pick_qty, sto_number
      ) 
      SELECT * FROM UNNEST ($1::int[], $2::text[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[])
      ON CONFLICT (picklist_number, product_id, location_id, sto_number) 
      DO UPDATE SET sort_order = EXCLUDED.sort_order;
    `;

    // Siapkan array untuk masing-masing kolom (9 Kolom)
    const s_ord = [], p_num = [], d_pick = [], cust = [], c_name = [], p_id = [], l_id = [], qty = [], s_num = [];

    data.forEach(row => {
      s_ord.push(row.sort_order);
      p_num.push(row.picklist_number);
      d_pick.push(row.date_picklist);
      cust.push(row.customer);
      c_name.push(row.customer_name);
      p_id.push(row.product_id);
      l_id.push(row.location_id);
      qty.push(row.pick_qty);
      s_num.push(row.sto_number);
    });

    // Jalankan query dengan 9 parameter
    await client.query(query, [
      s_ord, p_num, d_pick, cust, c_name, p_id, l_id, qty, s_num
    ]);

    return res.status(200).json({ status: 'success', message: 'Data berhasil masuk dengan urutan tetap!' });

  } catch (err) {
    console.error("Database Error:", err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
