const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  // --- HEADERS CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try {
    client = await pool.connect();

    // ==========================================
    // 1. LOGIKA SIMPAN DATA (POST) - Update Qty & Shortage
    // ==========================================
    if (req.method === 'POST') {
      const { action, picklist_number, product_id, location_id, qty_actual, qty_missing, picker_name } = req.body;

      // A. JIKA ACTION ADALAH MARK_SHORTAGE
      if (action === 'mark_shortage') {
        const queryShortage = `
          UPDATE picklist_raw 
          SET status = 'shortage', 
              keterangan = $1, 
              picker_name = $2,
              updated_at = CURRENT_TIMESTAMP
          WHERE picklist_number = $3 AND product_id = $4 AND location_id = $5
        `;
        const ket = `Shortage ${qty_missing} pcs oleh ${picker_name}`;
        await client.query(queryShortage, [ket, picker_name, picklist_number, product_id, location_id]);
        return res.status(200).json({ status: 'success', message: 'Shortage recorded' });
      }

      // B. JIKA ACTION ADALAH UPDATE_QTY (PICKING NORMAL)
      if (action === 'update_qty') {
        // Ambil data lama dulu untuk kalkulasi total
        const check = await client.query(
          `SELECT qty_pick, COALESCE(qty_actual, 0) as current FROM picklist_raw WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
          [picklist_number, product_id, location_id]
        );

        if (check.rows.length > 0) {
          const item = check.rows[0];
          const newTotal = item.current + parseInt(qty_actual);
          const newStatus = (newTotal >= item.qty_pick) ? 'fully picked' : 'partial';

          await client.query(
            `UPDATE picklist_raw SET qty_actual = $1, status = $2, picker_name = $3, updated_at = CURRENT_TIMESTAMP 
             WHERE picklist_number = $4 AND product_id = $5 AND location_id = $6`,
            [newTotal, newStatus, picker_name, picklist_number, product_id, location_id]
          );
          return res.status(200).json({ status: 'success', message: 'Updated' });
        }
      }
    }

    // ==========================================
    // 2. LOGIKA AMBIL DATA (GET) - Detail & List
    // ==========================================
    if (req.method === 'GET') {
      const { picklist_number } = req.query;

      if (picklist_number) {
        // AMBIL DETAIL LOKASI
        const queryDetail = `
          SELECT pr.location_id, 
          string_agg(pr.product_id || ' (' || COALESCE(mp.description, 'No Desc') || ') : ' || (pr.qty_pick - COALESCE(pr.qty_actual, 0)) || ' pcs', chr(10)) as sku_summary,
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
          WHERE pr.picklist_number = $1 AND pr.status != 'fully picked' AND (pr.qty_pick - COALESCE(pr.qty_actual, 0)) > 0
          GROUP BY pr.location_id, pr.zona, pr.row_val, pr.subrow, pr.level_val, pr.rak_raw
          ORDER BY pr.zona, pr.row_val, pr.subrow, pr.level_val, pr.rak_raw ASC
        `;
        const result = await client.query(queryDetail, [picklist_number]);
        return res.status(200).json({ status: 'success', data: result.rows });
      } else {
        // AMBIL LIST UTAMA
        const result = await client.query(`SELECT * FROM mv_picking_list`);
        return res.status(200).json({ status: 'success', data: result.rows });
      }
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
