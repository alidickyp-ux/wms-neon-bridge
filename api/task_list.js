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
      const { action, picklist_number, product_id, location_id, qty_actual, picker_name, inventory_reason } = req.body;

      await client.query('BEGIN');

      if (action === 'mark_shortage') {
        const inputQty = parseInt(qty_actual) || 0;
        const updateRawQuery = `
          UPDATE picklist_raw 
          SET qty_actual = COALESCE(qty_actual, 0) + $1, status = 'fully picked', picker_name = $2, updated_at = NOW()
          WHERE picklist_number = $3 AND product_id = $4 AND location_id = $5
          RETURNING qty_pick;
        `;
        const resRaw = await client.query(updateRawQuery, [inputQty, picker_name, picklist_number, product_id, location_id]);
        
        if (resRaw.rows.length === 0) throw new Error("Item tidak ditemukan");
        const qtyReqAsli = resRaw.rows[0].qty_pick;

        const resDesc = await client.query("SELECT description FROM master_product WHERE product_id = $1 LIMIT 1", [product_id]);
        const prodDesc = resDesc.rows.length > 0 ? resDesc.rows[0].description : 'No Description';

        await client.query(`
          INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, status, inventory_reason, description, scanned_at) 
          VALUES ($1, $2, $3, $4, $5, 'SHORTAGE', $6, $7, NOW())
        `, [picklist_number, product_id, location_id, inputQty, picker_name, inventory_reason, prodDesc]);

        await client.query(`
          INSERT INTO picking_compliance (picklist_number, product_id, location_id, description, qty_pick, keterangan, status_awal, status_akhir, inventory_reason) 
          VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', 'WAITING', $7)
        `, [picklist_number, product_id, location_id, prodDesc, qtyReqAsli, `Shortage oleh ${picker_name}`, inventory_reason]);

        await client.query('COMMIT');
        return res.status(200).json({ status: 'success', message: 'Shortage tersinkron' });
      }

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
          return res.status(200).json({ status: 'success' });
        }
      }
    }

    // ==========================================
    // 2. LOGIKA AMBIL DATA (GET) - ANTI GAGAL DATA ITEMS
    // ==========================================
    if (req.method === 'GET') {
      const { action, picklist_number } = req.query;

      // JIKA action = get_list (Daftar PCB Utama)
      if (action === 'get_list' || !picklist_number) {
        const queryList = `
          SELECT 
            p.picklist_number, 
            p.nama_customer, 
            p.status,
            SUM(p.qty_pick)::int AS total_qty,
            -- SUBQUERY UNTUK MENYERTAKAN ITEMS LANGSUNG DI LIST PCB
            COALESCE((
              SELECT json_agg(json_build_object(
                'product_id', sub.product_id,
                'description', COALESCE(mp.description, sub.product_id),
                'location_id', sub.location_id,
                'qty_pick', sub.qty_pick,
                'qty_actual', COALESCE(sub.qty_actual, 0),
                'sisa_qty', (sub.qty_pick - COALESCE(sub.qty_actual, 0)),
                'status', sub.status
              ))
              FROM picklist_raw sub
              LEFT JOIN master_product mp ON sub.product_id = mp.product_id
              WHERE sub.picklist_number = p.picklist_number 
              AND sub.status != 'fully picked'
            ), '[]') as items
          FROM picklist_raw p 
          WHERE p.status != 'fully picked'
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.picklist_number DESC
        `;
        const result = await client.query(queryList);
        return res.status(200).json({ status: 'success', data: result.rows });
      } 
      
      // JIKA MINTA DETAIL (Support model lama/detail per lokasi)
      if (picklist_number) {
        const queryDetail = `
          SELECT pr.location_id, 
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
          WHERE pr.picklist_number = $1 AND pr.status != 'fully picked'
          GROUP BY pr.location_id
        `;
        const result = await client.query(queryDetail, [picklist_number]);
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
