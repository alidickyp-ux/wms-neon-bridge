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
      const { action, picklist_number, product_id, location_id, qty_actual, picker_name, inventory_reason } = req.body;

      try {
        await client.query('BEGIN');

        if (action === 'mark_shortage') {
          const inputQty = parseInt(qty_actual) || 0;
          const reason = inventory_reason || 'Barang Tidak Ada';

          // 1. UPDATE STATUS RAW
          await client.query(
            `UPDATE picklist_raw SET status = 'fully picked', picker_name = $1, updated_at = NOW()
             WHERE picklist_number = $2 AND product_id = $3 AND location_id = $4`,
            [picker_name, picklist_number, product_id, location_id]
          );

          // 2. AMBIL DESKRIPSI
          const resDesc = await client.query("SELECT description FROM master_product WHERE product_id = $1 LIMIT 1", [product_id]);
          const prodDesc = resDesc.rows.length > 0 ? resDesc.rows[0].description : 'No Description';

          // 3. INSERT COMPLIANCE (Sebut Nama Kolom Satu-Satu!)
          // Kita JANGAN masukkan final_reason di sini supaya database pakai DEFAULT-nya atau NULL
          const queryCompliance = `
            INSERT INTO picking_compliance (
              picklist_number, product_id, location_id, description, 
              qty_pick, keterangan, status_awal, status_akhir, inventory_reason
            ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', 'WAITING', $7)
          `;
          await client.query(queryCompliance, [
            picklist_number, product_id, location_id, prodDesc, 
            inputQty, `Shortage oleh ${picker_name}`, reason
          ]);

          // 4. INSERT TRANSAKSI
          await client.query(
            `INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, status, inventory_reason, description, scanned_at) 
             VALUES ($1, $2, $3, $4, $5, 'SHORTAGE', $6, $7, NOW())`,
            [picklist_number, product_id, location_id, inputQty, picker_name, reason, prodDesc]
          );

          await client.query('COMMIT');
          return res.status(200).json({ status: 'success' });

        } else if (action === 'update_qty') {
          const inputQty = parseInt(qty_actual) || 0;
          const check = await client.query(
            `SELECT qty_pick, COALESCE(qty_actual, 0) as current FROM picklist_raw WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
            [picklist_number, product_id, location_id]
          );

          if (check.rows.length > 0) {
            const item = check.rows[0];
            const newTotal = item.current + inputQty;
            const newStatus = (newTotal >= item.qty_pick) ? 'fully picked' : 'partial picked';

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
          throw new Error("Data tidak ditemukan");
        }
      } catch (postErr) {
        await client.query('ROLLBACK');
        console.error("LOG ERROR POST:", postErr.message);
        return res.status(500).json({ status: 'error', message: postErr.message });
      }
    }

    // ==========================================
    // 2. LOGIKA AMBIL DATA (GET) - GAK BERUBAH
    // ==========================================
    if (req.method === 'GET') {
      const { action, picklist_number } = req.query;

      if (action === 'get_packing') {
        const resPacking = await client.query(`
          SELECT p.picklist_number, p.nama_customer, p.status, 
          SUM(p.qty_pick)::int AS total_qty, SUM(p.qty_actual)::int AS total_picked,
          COALESCE((
            SELECT json_agg(json_build_object(
              'product_id', sub.product_id,
              'description', COALESCE(mp.description, sub.product_id),
              'location_id', sub.location_id,
              'qty_pick', sub.qty_pick,
              'qty_actual', COALESCE(sub.qty_actual, 0),
              'status', sub.status
            ))
            FROM picklist_raw sub
            LEFT JOIN master_product mp ON sub.product_id = mp.product_id
            WHERE sub.picklist_number = p.picklist_number
          ), '[]') as items
          FROM picklist_raw p 
          WHERE p.status IN ('partial picked', 'fully picked')
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.updated_at DESC
        `);
        return res.status(200).json({ status: 'success', data: resPacking.rows });
      }

      if (action === 'get_list' || !picklist_number) {
        const resList = await client.query(`
          SELECT p.picklist_number, p.nama_customer, p.status, SUM(p.qty_pick)::int AS total_qty,
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
              WHERE sub.picklist_number = p.picklist_number AND sub.status != 'fully picked'
          ), '[]') as items
          FROM picklist_raw p WHERE p.status != 'fully picked'
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.picklist_number DESC
        `);
        return res.status(200).json({ status: 'success', data: resList.rows });
      }

      if (picklist_number) {
        const resDetail = await client.query(`
          SELECT pr.location_id, json_agg(json_build_object(
            'product_id', pr.product_id, 'description', mp.description,
            'qty_pick', pr.qty_pick, 'qty_actual', COALESCE(pr.qty_actual, 0),
            'sisa_qty', (pr.qty_pick - COALESCE(pr.qty_actual, 0)),
            'status', pr.status
          )) as items_json
          FROM picklist_raw pr
          LEFT JOIN master_product mp ON pr.product_id = mp.product_id 
          WHERE pr.picklist_number = $1 AND pr.status != 'fully picked'
          GROUP BY pr.location_id
        `, [picklist_number]);
        return res.status(200).json({ status: 'success', data: resDetail.rows });
      }
    }

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
