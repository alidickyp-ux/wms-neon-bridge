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

  try {
    const { data } = req.body;

    // Cek apakah ada data yang dikirim
    if (!data || !Array.isArray(data)) {
      throw new Error("Format data salah atau data kosong");
    }

    // Query SQL untuk Insert atau Ignore jika duplikat
    const query = `
      INSERT INTO picklist (
        picklist_number, date_picklist, customer, customer_name, 
        product_id, location_id, pick_qty, sto_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (picklist_number, product_id, location_id, sto_number) DO NOTHING
    `;

    // Proses semua data dalam loop
    for (const row of data) {
      await client.query(query, [
        row.picklist_number,
        row.date_picklist,
        row.customer,
        row.customer_name,
        row.product_id,
        row.location_id,
        row.pick_qty,
        row.sto_number
      ]);
    }

    return res.status(200).json({ 
      status: 'success', 
      message: 'Data berhasil masuk ke Neon!' 
    });

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
