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
      /** * LOGIKA DETAIL: GROUPING BERDASARKAN LOKASI
       * Menghimpun beberapa SKU dalam satu lokasi agar picker tidak bingung
       */
      const queryDetail = `
        SELECT 
          location_id, 
          string_agg(product_id || ' : ' || qty_pick || ' pcs', chr(10)) as sku_summary,
          json_agg(json_build_object(
            'product_id', product_id, 
            'qty_pick', qty_pick,
            'status', status
          )) as items_json
        FROM picklist_raw 
        WHERE picklist_number = $1 AND status != 'fully picked'
        GROUP BY location_id, zona, row_val, subrow, level_val, rak_raw
        ORDER BY 
          zona ASC, 
          row_val ASC, 
          subrow ASC, 
          level_val ASC, 
          rak_raw ASC
      `;
      const result = await client.query(queryDetail, [picklist_number]);
      
      return res.status(200).json({
        status: 'success',
        data: result.rows
      });

    } else {
      /** * LOGIKA LIST UTAMA - Menggunakan Materialized View (Cepat)
       */
      const queryList = `SELECT * FROM mv_picking_list`;
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
