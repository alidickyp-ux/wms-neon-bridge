const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try {
    client = await pool.connect();

    // GET: Ambil daftar WAITING
    if (req.method === 'GET') {
      const result = await client.query(
        "SELECT * FROM picking_compliance WHERE status_akhir = 'WAITING' ORDER BY created_at DESC"
      );
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    // POST: Update menjadi CLOSED
    if (req.method === 'POST') {
      const { id, inventory_note } = req.body;
      await client.query(
        "UPDATE picking_compliance SET status_akhir = 'CLOSED', keterangan = keterangan || $1, updated_at = NOW() WHERE id = $2",
        [` | CLOSED Note: ${inventory_note}`, id]
      );
      return res.status(200).json({ status: 'success' });
    }
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
