const { Pool } = require('pg');

// Konfigurasi koneksi ke Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  // 1. Atur Header CORS agar bisa diakses oleh Google Apps Script
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. Tangani Preflight Request (OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. Hanya izinkan metode POST
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      status: 'error', 
      message: 'Gunakan metode POST' 
    });
  }

  const client = await pool.connect();

// ... (bagian atas tetap sama)
  try {
    const { data } = req.body;
    const client = await pool.connect();

    // Menggunakan teknik Unnest untuk kirim banyak data sekaligus dalam 1 query
    const query = `
      INSERT INTO picklist (
        picklist_number, date_picklist, customer, customer_name, 
        product_id, location_id, pick_qty, sto_number
      ) 
      SELECT * FROM UNNEST ($1::text[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[])
      ON CONFLICT (picklist_number, product_id, location_id, sto_number) DO NOTHING
    `;

    // Siapkan array untuk masing-masing kolom
    const cols = {
      p_num: [], d_pick: [], cust: [], c_name: [], p_id: [], l_id: [], qty: [], s_num: []
    };

    data.forEach(row => {
      cols.p_num.push(row.picklist_number);
      cols.d_pick.push(row.date_picklist);
      cols.cust.push(row.customer);
      cols.c_name.push(row.customer_name);
      cols.p_id.push(row.product_id);
      cols.l_id.push(row.location_id);
      cols.qty.push(row.pick_qty);
      cols.s_num.push(row.sto_number);
    });

    await client.query(query, [
      cols.p_num, cols.d_pick, cols.cust, cols.c_name, cols.p_id, cols.l_id, cols.qty, cols.s_num
    ]);

    client.release();
    return res.status(200).json({ status: 'success', message: 'Data berhasil masuk!' });
// ... (sisanya tetap sama)

  } catch (err) {
    console.error("Database Error:", err.message);
    return res.status(500).json({ 
      status: 'error', 
      message: err.message 
    });
  } finally {
    client.release(); // Pastikan koneksi dilepas kembali ke pool
  }
};
