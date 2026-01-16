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
    // 1. LOGIKA SIMPAN DATA (POST)
    // ==========================================
    if (req.method === 'POST') {
      const { 
        action, 
        picklist_number, 
        product_id, 
        location_id, 
        qty_actual, 
        picker_name, 
        inventory_reason 
      } = req.body;

      await client.query('BEGIN'); // Mulai Transaksi Database

      // A. JIKA ACTION ADALAH MARK_SHORTAGE (Alur Baru 5-7)
      if (action === 'mark_shortage') {
        // 1. Update picklist_raw: Paksa jadi 'fully picked' agar picker lanjut
        const updateRaw = `
          UPDATE picklist_raw 
          SET qty_actual = qty_pick, status = 'fully picked', picker_name = $1, updated_at = NOW()
          WHERE picklist_number = $2 AND product_id = $3 AND location_id = $4
          RETURNING qty_pick;
        `;
        const resRaw = await client.query(updateRaw, [picker_name, picklist_number, product_id, location_id]);
        
        if (resRaw.rows.length === 0) throw new Error("Item tidak ditemukan di Picklist Raw");
        const qtyPickAsli = resRaw.rows[0].qty_pick;

        // 2. Insert picking_transactions: Catat log status SHORTAGE
        const insertTrans = `
          INSERT INTO picking_transactions (
            picklist_number, product_id, location_id, qty_actual, picker_name, status, inventory_reason, scanned_at
          ) VALUES ($1, $2, $3, $4, $5, 'SHORTAGE', $6, NOW())
        `;
        await client.query(insertTrans, [picklist_number, product_id, location_id, qty_actual, picker_name, inventory_reason]);

        // 3. Insert picking_compliance: Daftar kerja Tim Inventory
        const insertCompliance = `
          INSERT INTO picking_compliance (
            picklist_number, product_id, location_id, qty_pick, keterangan, status_awal, status_akhir, inventory_reason
          ) VALUES ($1, $2, $3, $4, $5, 'OPEN', 'WAITING', $6)
        `;
        const catatan = `Shortage oleh ${picker_name}. Fisik: ${qty_actual} / Req: ${qtyPickAsli}`;
        await client.query(insertCompliance, [picklist_number, product_id, location_id, qtyPickAsli, catatan, inventory_reason]);

        await client.query('COMMIT');
        return res.status(200).json({ status: 'success', message: 'Shortage tersinkron ke Compliance' });
      }

      // B. JIKA ACTION ADALAH UPDATE_QTY (PICKING NORMAL)
      if (action === 'update_qty') {
        const check = await client.query(
          `SELECT qty_pick, COALESCE(qty_actual, 0) as current FROM picklist_raw WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
          [picklist_number, product_id, location_id]
        );

        if (check.rows.length > 0) {
          const item = check.rows[0];
          const newTotal = item.current + parseInt(qty_actual);
          const newStatus = (newTotal >= item.qty_pick) ? 'fully picked' : 'partial';

          // Update Raw
          await client.query(
            `UPDATE picklist_raw SET qty_actual = $1, status = $2, picker_name = $3, updated_at = NOW() 
             WHERE picklist_number = $4 AND product_id = $5 AND location_id = $6`,
            [newTotal, newStatus, picker_name, picklist_number, product_id, location_id]
          );

          // Insert Transaction Normal
          await client.query(
            `INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, status, scanned_at) 
             VALUES ($1, $2, $3, $4, $5, 'NORMAL', NOW())`,
            [picklist_number, product_id, location_id, qty_actual, picker_name]
          );

          await client.query('COMMIT');
          return res.status(200).json({ status: 'success', message: 'Update Qty Berhasil' });
        }
      }
      throw new Error("Action tidak dikenali atau data tidak ditemukan");
    }

    // ==========================================
    // 2. LOGIKA AMBIL DATA (GET)
    // ==========================================
    if (req.method === 'GET') {
      const { picklist_number } = req.query;

      if (picklist_number) {
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
          WHERE pr.picklist_number = $1 
            AND pr.status != 'fully picked' 
            AND (pr.qty_pick - COALESCE(pr.qty_actual, 0)) > 0
          GROUP BY pr.location_id, pr.zona, pr.row_val, pr.subrow, pr.level_val, pr.rak_raw
          ORDER BY pr.zona, pr.row_val, pr.subrow, pr.level_val, pr.rak_raw ASC
        `;
        const result = await client.query(queryDetail, [picklist_number]);
        return res.status(200).json({ status: 'success', data: result.rows });
      } else {
        const result = await client.query(`SELECT * FROM mv_picking_list`);
        return res.status(200).json({ status: 'success', data: result.rows });
      }
    }

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
