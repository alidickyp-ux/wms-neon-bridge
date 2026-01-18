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

    if (req.method === 'POST') {
      const { 
        action, picklist_number, product_id, location_id, 
        qty_actual, picker_name, inventory_reason 
      } = req.body;

      await client.query('BEGIN');

      // --- 1. LOGIKA SHORTAGE (Lapor Komplain) ---
      if (action === 'mark_shortage') {
        const inputQty = parseInt(qty_actual) || 0; 

        // Update raw jadi 'fully picked' agar bisa ditarik ke Packing
        const updateRaw = await client.query(`
          UPDATE picklist_raw 
          SET status = 'fully picked', picker_name = $1, updated_at = NOW()
          WHERE picklist_number = $2 AND product_id = $3 AND location_id = $4
          RETURNING qty_pick;
        `, [picker_name, picklist_number, product_id, location_id]);
        
        const qtyReqAsli = updateRaw.rows[0]?.qty_pick || 0;
        const resDesc = await client.query("SELECT description FROM master_product WHERE product_id = $1 LIMIT 1", [product_id]);
        const prodDesc = resDesc.rows.length > 0 ? resDesc.rows[0].description : 'No Description';

        // Log ke Transaksi Shortage
        await client.query(`
          INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, status, inventory_reason, description, scanned_at) 
          VALUES ($1, $2, $3, $4, $5, 'SHORTAGE', $6, $7, NOW())
        `, [picklist_number, product_id, location_id, inputQty, picker_name, inventory_reason, prodDesc]);

        // Log ke Compliance: WAITING agar muncul di menu komplain
        await client.query(`
          INSERT INTO picking_compliance (picklist_number, product_id, location_id, description, qty_pick, keterangan, status_awal, status_akhir, inventory_reason) 
          VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', 'WAITING', $7)
        `, [picklist_number, product_id, location_id, prodDesc, qtyReqAsli, `Shortage oleh ${picker_name}`, inventory_reason]);

        await client.query('COMMIT');
        return res.status(200).json({ status: 'success' });
      }

      // --- 2. LOGIKA NORMAL PICKING ---
      if (action === 'update_qty') {
        const inputQty = parseInt(qty_actual) || 0;
        const check = await client.query(
          `SELECT qty_pick, COALESCE(qty_actual, 0) as current FROM picklist_raw WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
          [picklist_number, product_id, location_id]
        );

        if (check.rows.length > 0) {
          const newTotal = check.rows[0].current + inputQty;
          // Status partial picked jika belum lengkap, fully picked jika sudah lengkap
          const newStatus = (newTotal >= check.rows[0].qty_pick) ? 'fully picked' : 'partial picked';

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

    if (req.method === 'GET') {
      const { action } = req.query;

      // GET LIST UNTUK PICKER (Hanya Open & Partial Picked)
      if (action === 'get_list') {
        const query = `
          SELECT p.picklist_number, p.nama_customer, p.status, SUM(p.qty_pick)::int AS total_qty,
          (SELECT json_agg(sub) FROM (
             SELECT s.product_id, COALESCE(mp.description, s.product_id) as description, s.location_id, s.qty_pick, 
             COALESCE(s.qty_actual, 0) as qty_actual, (s.qty_pick - COALESCE(s.qty_actual, 0)) as sisa_qty, s.status
             FROM picklist_raw s LEFT JOIN master_product mp ON s.product_id = mp.product_id
             WHERE s.picklist_number = p.picklist_number AND s.status != 'fully picked'
          ) sub) as items
          FROM picklist_raw p 
          WHERE p.status IN ('Open', 'open', 'partial picked')
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.picklist_number DESC
        `;
        const result = await client.query(query);
        return res.status(200).json({ status: 'success', data: result.rows });
      }

      // GET LIST UNTUK PACKING (Menarik status partial picked & fully picked)
      if (action === 'get_packing') {
        const query = `
          SELECT p.picklist_number, p.nama_customer, p.status, SUM(p.qty_actual)::int AS total_picked
          FROM picklist_raw p 
          WHERE p.status IN ('partial picked', 'fully picked')
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.updated_at DESC
        `;
        const result = await client.query(query);
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
