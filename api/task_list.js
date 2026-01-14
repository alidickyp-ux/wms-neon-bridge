const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  
  let client;
  try {
    client = await pool.connect();
    
    // Ambil parameter picklist_number dari URL (jika ada)
    const { picklist_number } = req.query;

    if (picklist_number) {
      /** * LOGIKA DETAIL: 
       * Muncul saat kartu diklik. Menampilkan Location, Product ID, dan Qty.
       */
      const queryDetail = `
        SELECT 
          location_id, 
          product_id, 
          qty_pick as qty,
          status
        FROM picklist_raw 
        WHERE picklist_number = $1
        ORDER BY location_id ASC
      `;
      const result = await client.query(queryDetail, [picklist_number]);
      
      return res.status(200).json({
        status: 'success',
        data: result.rows
      });

    } else {
      /** * LOGIKA LIST UTAMA: 
       * Muncul di halaman depan (Halaman Pink).
       */
      const queryList = `
        SELECT 
          picklist_number, 
          nama_customer, 
          SUM(qty_pick) as total_qty, 
          status
        FROM picklist_raw 
        WHERE status IN ('open', 'partial picked')
        GROUP BY picklist_number, nama_customer, status
        ORDER BY picklist_number DESC
      `;
      const result = await client.query(queryList);
      
      return res.status(200).json({
        status: 'success',
        data: result.rows
      });
    }

  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
