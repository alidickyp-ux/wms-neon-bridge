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
          pr.location_id, 
          -- Summary juga kita update agar ada deskripsinya jika perlu
          string_agg(pr.product_id || ' (' || COALESCE(mp.description, 'No Desc') || ') : ' || pr.qty_pick || ' pcs', chr(10)) as sku_summary,
          json_agg(json_build_object(
            'product_id', pr.product_id, 
            'description', mp.description, -- AMBIL DARI MASTER_PRODUCT
            'qty_pick', pr.qty_pick,
            'status', pr.status
          )) as items_json
        FROM picklist_raw pr
        LEFT JOIN master_product mp ON pr.product_id = mp.product_id -- JOIN KE MASTER
        WHERE pr.picklist_number = $1 AND pr.status != 'fully picked'
        GROUP BY pr.location_id, pr.zona, pr.row_val, pr.subrow, pr.level_val, pr.rak_raw
        ORDER BY 
          pr.zona ASC, 
          pr.row_val ASC, 
          pr.subrow ASC, 
          pr.level_val ASC, 
          pr.rak_raw ASC
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
