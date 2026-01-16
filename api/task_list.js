const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
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

      await client.query('BEGIN');

      // --- A. JIKA ACTION: MARK_SHORTAGE ---
      if (action === 'mark_shortage') {
        const inputQty = parseInt(qty_actual) || 0;

        // 1. Update picklist_raw: Tambahkan sisa ke qty_actual & set status FULL agar hilang dari antrean
        const updateRawQuery = `
          UPDATE picklist_raw 
          SET 
            qty_actual = COALESCE(qty_actual, 0) + $1, 
            status = 'fully picked', 
            picker_name = $2, 
            updated_at = NOW()
          WHERE picklist_number = $3 AND product_id = $4 AND location_id = $5
          RETURNING qty_pick;
        `;
        const resRaw = await client.query(updateRawQuery, [inputQty, picker_name, picklist_number, product_id, location_id]);
        
        if (resRaw.rows.length === 0) throw new Error("Item tidak ditemukan");
        const qtyReqAsli = resRaw.rows[0].qty_pick;

        // 2. Ambil Deskripsi Barang
        const resDesc = await client.query("SELECT description FROM master_product WHERE product_id = $1 LIMIT 1", [product_id]);
        const prodDesc = resDesc.rows.length > 0 ? resDesc.rows[0].description : 'No Description';

        // 3. Insert Log Transaksi (Status SHORTAGE)
        const insertTransQuery = `
          INSERT INTO picking_transactions (
            picklist_number, product_id, location_id, qty_actual, picker_name, status, inventory_reason, description, scanned_at
          ) VALUES ($1, $2, $3, $4, $5, 'SHORTAGE', $6, $7, NOW())
        `;
        await client.query(insertTransQuery, [picklist_number, product_id, location_id, inputQty, picker_name, inventory_reason, prodDesc]);

        // 4. Insert ke Compliance untuk Tim Inventory
        const insertCompQuery = `
          INSERT INTO picking_compliance (
            picklist_number, product_id, location_id, description, qty_pick, keterangan, status_awal, status_akhir, inventory_reason
          ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', 'WAITING', $7)
        `;
        const catatan = `Shortage dilaporkan oleh ${picker_name}. Jumlah fisik: ${inputQty} pcs.`;
        await client.query(insertCompQuery, [picklist_number, product_id, location_id, prodDesc, qtyReqAsli, catatan, inventory_reason]);

        await client.query('COMMIT');

        // Optimasi: Refresh daftar di background
        pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list').catch(e => console.error("MV Refresh Error:", e));

        return res.status(200).json({ status: 'success', message: 'Shortage tersinkron' });
      }

      // --- B. JIKA ACTION: UPDATE_QTY (NORMAL) ---
      if (action === 'update_qty') {
        const checkRes = await client.query(
          `SELECT qty_pick, COALESCE(qty_actual, 0) as current FROM picklist_raw WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
          [picklist_number, product_id, location_id]
        );

        if (checkRes.rows.length > 0) {
          const item = checkRes.rows[0];
          const inputQty = parseInt(qty_actual) || 0;
          const newTotal = item.current + inputQty;
          const newStatus = (newTotal >= item.qty_pick) ? 'fully picked' : 'partial';

          await client.query(
            `UPDATE picklist_raw SET qty_actual = $1, status = $2, picker_name = $3, updated_at = NOW() WHERE picklist_number = $4 AND product_id = $5 AND location_id = $6`,
            [newTotal, newStatus, picker_name, picklist_number, product_id, location_id]
          );

          await client.query(
            `INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, status, scanned_at) VALUES ($1, $2, $3, $4, $5, 'NORMAL', NOW())`,
            [picklist_number, product_id, location_id, inputQty, picker_name]
          );

          await client.query('COMMIT');

          pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list').catch(e => console.error("MV Refresh Error:", e));

          return res.status(200).json({ status: 'success' });
        }
      }
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
          WHERE pr.picklist_number = $1 AND pr.status != 'fully picked' AND (pr.qty_pick - COALESCE(pr.qty_actual, 0)) > 0
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
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
