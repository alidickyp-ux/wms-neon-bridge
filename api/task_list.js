const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  // --- SET HEADERS UNTUK CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  let client;
  try {
    client = await pool.connect();
    
    const { picklist_number } = req.query;

    if (picklist_number) {
      /** * LOGIKA DETAIL: MENGHITUNG SISA QTY (PARTIAL PICKING)
       * Menggunakan COALESCE agar jika qty_actual NULL, dianggap 0.
       * Ini mencegah Error 500 saat perhitungan matematika.
       */
      const queryDetail = `
        SELECT 
          pr.location_id, 
          -- Summary teks untuk daftar lokasi
          string_agg(
            pr.product_id || ' (' || COALESCE(mp.description, 'No Desc') || ') : ' || 
            (pr.qty_pick - COALESCE(pr.qty_actual, 0)) || ' pcs', 
            chr(10)
          ) as sku_summary,
          -- JSON Aggregation untuk dikirim ke Android
          json_agg(json_build_object(
            'product_id', pr.product_id, 
            'description', mp.description,
            'qty_pick', pr.qty_pick,
            'qty_actual', COALESCE(pr.qty_actual, 0),
            'sisa_qty', (pr.qty_pick - COALESCE(pr.qty_actual, 0)),
            'status', pr.status
          )) as items_json
        FROM picklist_raw pr
        LEFT JOIN master_product mp ON pr.product_id = mp.product_id 
        WHERE pr.picklist_number = $1 
          AND pr.status != 'fully picked' 
          -- Hanya tampilkan barang yang sisanya masih > 0
          AND (pr.qty_pick - COALESCE(pr.qty_actual, 0)) > 0 
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
      /** * LOGIKA LIST UTAMA (PCB LIST)
       * Menampilkan daftar semua picklist yang tersedia
       */
      const queryList = `SELECT * FROM mv_picking_list`;
      const result = await client.query(queryList);
      
      return res.status(200).json({
        status: 'success',
        data: result.rows
      });
    }

  } catch (err) {
    // Memberikan pesan error yang lebih jelas ke Logcat Android jika terjadi crash
    console.error("Database Error:", err.message);
    return res.status(500).json({ 
      status: 'error', 
      message: "Server Error: " + err.message 
    });
  } finally {
    if (client) client.release();
  }
};
