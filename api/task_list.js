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
    
    const { picklist_number } = req.query;

    if (picklist_number) {
      /** * LOGIKA DETAIL DENGAN OPTIMASI RUTE PICKING
       * Mengurutkan berdasarkan Lantai, Zonasi, Row, Subrow, dan Rak
       */
      const queryDetail = `
        SELECT 
          location_id, 
          product_id, 
          qty_pick as qty,
          status
        FROM picklist_raw 
        WHERE picklist_number = $1
        ORDER BY 
          lantai_level ASC,
          zona ASC, 
          row_val ASC,
          level_val ASC,
          subrow ASC, 
      `;
      const result = await client.query(queryDetail, [picklist_number]);
      
      return res.status(200).json({
        status: 'success',
        data: result.rows
      });

    } else {
      /** * LOGIKA LIST UTAMA
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
