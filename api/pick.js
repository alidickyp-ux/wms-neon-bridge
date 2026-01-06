const { Pool } = require('pg');

// Konfigurasi koneksi ke Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  // 1. Header CORS agar bisa diakses dari aplikasi Android/Web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Gunakan metode POST' });
  }

  let client;

  try {
    const { picklist_number, product_id, location_id, sto_number, qty_actual, picker_name } = req.body;

    // Validasi input dasar
    if (!picklist_number || !product_id || !location_id || !qty_actual) {
      return res.status(400).json({ status: 'error', message: 'Data scan tidak lengkap' });
    }

    client = await pool.connect();

    // 2. CEK DATA MASTER: Apakah SKU dan Lokasi ini memang ada di picklist tersebut?
    const checkMaster = await client.query(
      `SELECT qty_pick FROM picklist_raw 
       WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
      [picklist_number, product_id, location_id]
    );

    if (checkMaster.rows.length === 0) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'Barang tidak ditemukan di daftar picklist ini!' 
      });
    }

    const qtyRequest = checkMaster.rows[0].qty_pick;

    // 3. HITUNG AKUMULASI: Berapa yang sudah di-scan sebelumnya?
    const checkExisting = await client.query(
      `SELECT SUM(qty_actual) as total FROM picking_transactions 
       WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
      [picklist_number, product_id, location_id]
    );

    const sudahDiambil = parseInt(checkExisting.rows[0].total || 0);
    const sisaBolehAmbil = qtyRequest - sudahDiambil;

    // 4. VALIDASI QTY: Apakah input sekarang melebihi sisa permintaan?
    if (qty_actual > sisaBolehAmbil) {
      return res.status(400).json({ 
        status: 'error', 
        message: `Input berlebih! Sisa yang dibutuhkan hanya ${sisaBolehAmbil}` 
      });
    }

    // 5. SIMPAN TRANSAKSI KE TABEL picking_transactions
    const insertQuery = `
      INSERT INTO picking_transactions (
        picklist_number, product_id, location_id, sto_number, qty_actual, picker_name
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `;
    
    await client.query(insertQuery, [
      picklist_number, product_id, location_id, sto_number, qty_actual, picker_
