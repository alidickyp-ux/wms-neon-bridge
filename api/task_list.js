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
      const { action, picklist_number, product_id, location_id, qty_actual, picker_name, inventory_reason, id, final_reason } = req.body;

      try {
        await client.query('BEGIN');

        // --- A. LOGIKA SHORTAGE (DARI PICKER) ---
        // UPDATE: Sekarang mendukung akumulasi (Normal + Shortage)
        if (action === 'mark_shortage') {
          const shortageFoundQty = parseInt(qty_actual) || 0; 
          const reason = inventory_reason || 'Barang Tidak Ada';

          // 1. Ambil qty yang sudah ada (hasil scan normal sebelumnya)
          const currentData = await client.query(
            `SELECT COALESCE(qty_actual, 0) as existing_qty FROM picklist_raw 
             WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
            [picklist_number, product_id, location_id]
          );

          const existingQty = currentData.rows.length > 0 ? currentData.rows[0].existing_qty : 0;
          
          // Total Akhir = Yang sudah discan normal + yang ditemukan pas shortage
          const finalQtyActual = existingQty + shortageFoundQty;

          const resDesc = await client.query("SELECT description FROM master_product WHERE product_id = $1 LIMIT 1", [product_id]);
          const prodDesc = resDesc.rows.length > 0 ? resDesc.rows[0].description : 'No Description';

          // 2. Update Raw dengan TOTAL AKUMULASI (Agar Header Packing Benar)
          await client.query(
            `UPDATE picklist_raw 
             SET qty_actual = $1, 
                 status = 'fully picked', 
                 picker_name = $2, 
                 updated_at = NOW() 
             WHERE picklist_number = $3 AND product_id = $4 AND location_id = $5`,
            [finalQtyActual, picker_name, picklist_number, product_id, location_id]
          );

          // 3. Insert History
          await client.query(
            `INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, scanned_at, description, status, inventory_reason) 
             VALUES ($1, $2, $3, $4, $5, NOW(), $6, 'SHORTAGE', $7)`,
            [picklist_number, product_id, location_id, shortageFoundQty, picker_name, prodDesc, reason]
          );

          // 4. Masukkan ke Compliance (Hanya jumlah shortage-nya saja)
          await client.query(
            `INSERT INTO picking_compliance (picklist_number, product_id, location_id, description, qty_pick, keterangan, status_awal, status_akhir, inventory_reason) 
             VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', 'WAITING', $7)`,
            [picklist_number, product_id, location_id, prodDesc, shortageFoundQty, `Shortage oleh ${picker_name}`, reason]
          );

          await client.query('COMMIT');
          return res.status(200).json({ status: 'success' });
        }

        // --- B. LOGIKA UPDATE QTY NORMAL (SCAN BIASA) ---
        if (action === 'update_qty') {
          const inputQty = parseInt(qty_actual) || 0;
          const checkRes = await client.query(
            `SELECT qty_pick, COALESCE(qty_actual, 0) as current FROM picklist_raw WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
            [picklist_number, product_id, location_id]
          );

          if (checkRes.rows.length > 0) {
            const item = checkRes.rows[0];
            const newTotal = item.current + inputQty; 

            if (newTotal > item.qty_pick) {
              throw new Error(`Qty melebihi request! Maksimal: ${item.qty_pick}`);
            }

            const newStatus = (newTotal >= item.qty_pick) ? 'fully picked' : 'partial picked';

            await client.query(
              `UPDATE picklist_raw SET qty_actual = $1, status = $2, picker_name = $3, updated_at = NOW() WHERE picklist_number = $4 AND product_id = $5 AND location_id = $6`,
              [newTotal, newStatus, picker_name, picklist_number, product_id, location_id]
            );

            await client.query(
              `INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, scanned_at, status) 
               VALUES ($1, $2, $3, $4, $5, NOW(), 'NORMAL')`,
              [picklist_number, product_id, location_id, inputQty, picker_name]
            );

            await client.query('COMMIT');
            return res.status(200).json({ status: 'success' });
          }
          throw new Error("Item not found");
        }

        // --- C. LOGIKA RESOLVE COMPLIANCE (ADMIN) ---
        if (action === 'resolve_compliance') {
          if (!id) throw new Error("ID Compliance tidak ditemukan");
          await client.query(
            `UPDATE picking_compliance SET status_akhir = 'CLOSED', final_reason = $1, updated_at = NOW() WHERE id = $2`,
            [final_reason || 'Resolved', id]
          );
          await client.query('COMMIT');
          return res.status(200).json({ status: 'success' });
        }

      } catch (postErr) {
        await client.query('ROLLBACK');
        console.error("POST Error:", postErr.message);
        return res.status(500).json({ status: 'error', message: postErr.message });
      }
    }

    // ==========================================
    // 2. LOGIKA AMBIL DATA (GET)
    // ==========================================
    if (req.method === 'GET') {
      const { action, picklist_number } = req.query;

      if (action === 'get_compliance') {
        const resComp = await client.query(`
          SELECT c.*, p.nama_customer FROM picking_compliance c
          LEFT JOIN (SELECT DISTINCT picklist_number, nama_customer FROM picklist_raw) p ON c.picklist_number = p.picklist_number
          WHERE c.status_akhir = 'WAITING' ORDER BY c.created_at DESC
        `);
        return res.status(200).json({ status: 'success', data: resComp.rows });
      }

      if (action === 'get_packing') {
        const queryPacking = `
          SELECT p.picklist_number, p.nama_customer, p.status, 
          SUM(p.qty_pick)::int AS total_qty, SUM(p.qty_actual)::int AS total_picked,
          COALESCE((
            SELECT json_agg(json_build_object(
              'product_id', sub.product_id, 'description', COALESCE(mp.description, sub.product_id),
              'location_id', sub.location_id, 'qty_pick', sub.qty_pick,
              'qty_actual', COALESCE(sub.qty_actual, 0), 'status', sub.status
            )) FROM picklist_raw sub LEFT JOIN master_product mp ON sub.product_id = mp.product_id
            WHERE sub.picklist_number = p.picklist_number
          ), '[]') as items
          FROM picklist_raw p WHERE p.status IN ('partial picked', 'fully picked')
          GROUP BY p.picklist_number, p.nama_customer, p.status ORDER BY p.updated_at DESC
        `;
        const resPack = await client.query(queryPacking);
        return res.status(200).json({ status: 'success', data: resPack.rows });
      }

if (picklist_number && action !== 'get_list') {
        const resDetail = await client.query(`
          SELECT 
            pr.location_id, 
            pr.lantai_level, pr.zona, pr.row_val, pr.rak_raw, pr.level_val,
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
          GROUP BY 
            pr.location_id, pr.lantai_level, pr.zona, pr.row_val, pr.rak_raw, pr.level_val
          ORDER BY 
            pr.lantai_level ASC, 
            pr.zona ASC, 
            pr.row_val ASC, 
            pr.rak_raw ASC, 
            pr.level_val ASC
        `, [picklist_number]);
        return res.status(200).json({ status: 'success', data: resDetail.rows });
      }

      const resList = await client.query(`
        SELECT 
          p.picklist_number, 
          p.nama_customer, 
          p.status, 
          SUM(p.qty_pick)::int AS total_qty,
          COALESCE((
              SELECT json_agg(json_build_object(
                'product_id', sub.product_id, 
                'description', COALESCE(mp.description, sub.product_id),
                'location_id', sub.location_id, 
                'qty_pick', sub.qty_pick, 
                'qty_actual', COALESCE(sub.qty_actual, 0), 
                'sisa_qty', (sub.qty_pick - COALESCE(sub.qty_actual, 0)),
                'status', sub.status
              ) ORDER BY sub.lantai_level, sub.zona, sub.row_val, sub.rak_raw, sub.level_val) 
              FROM picklist_raw sub 
              LEFT JOIN master_product mp ON sub.product_id = mp.product_id
              WHERE sub.picklist_number = p.picklist_number AND sub.status != 'fully picked'
          ), '[]') as items 
        FROM picklist_raw p 
        WHERE p.status != 'fully picked'
        GROUP BY p.picklist_number, p.nama_customer, p.status 
        ORDER BY p.picklist_number DESC
      `);
      return res.status(200).json({ status: 'success', data: resList.rows });
    }

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error("Global Error:", err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
