const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  // Gunakan POST karena kita akan mengupdate data
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const { pcb, container, weight_kg } = req.body;

  // Validasi input
  if (!pcb || !container || !weight_kg) {
    return res.status(400).json({ error: "PCB, Container Number, and Weight are required" });
  }

  let client;
  try {
    client = await pool.connect();
    
    // Mulai Transaksi agar data konsisten
    await client.query('BEGIN');

    // 1. Update semua item di dalam container tersebut
    // Mengubah status 'open' menjadi 'closed' dan memasukkan beratnya
    const updateQuery = `
      UPDATE packing_transactions 
      SET 
        status = 'closed', 
        weight_kg = $1, 
        updated_at = NOW() 
      WHERE picklist_number = $2 
      AND container_number = $3 
      AND status = 'open'
    `;

    const result = await client.query(updateQuery, [weight_kg, pcb, container]);

    // Cek apakah ada baris yang terupdate
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: "No open items found in this container. Maybe it's already closed?" 
      });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      status: 'success',
      message: `Box ${container} berhasil di-close.`,
      total_items_closed: result.rowCount,
      weight: weight_kg
    });

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
