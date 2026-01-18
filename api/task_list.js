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
    // 1. SIMPAN DATA (POST)
    // ==========================================
    if (req.method === 'POST') {
      const { 
        action, picklist_number, product_id, location_id, 
        qty_actual, picker_name, inventory_reason 
      } = req.body;

      await client.query('BEGIN');

      // --- A. LOGIKA SHORTAGE (KOMPLAIN) ---
      if (action === 'mark_shortage') {
        const inputQty = parseInt(qty_actual) || 0; 

        // Update picklist_raw jadi 'fully picked' (agar bisa ditarik ke Packing & hilang dari daftar picking)
        const updateRaw = await client.query(`
          UPDATE picklist_raw 
          SET status = 'fully picked', picker_name = $1, updated_at = NOW()
          WHERE picklist_number = $2 AND product_id = $3 AND location_id = $4
          RETURNING qty_pick;
        `, [picker_name, picklist_number, product_id, location_id]);
        
        const qtyReqAsli = updateRaw.rows[0]?.qty_pick || 0;

        const resDesc = await client.query("SELECT description FROM master_product WHERE product_id = $1 LIMIT 1", [product_id]);
        const prodDesc = resDesc.rows.length > 0 ? resDesc.rows[0].description : 'No Description';

        // Log ke Transaksi
        await client.query(`
          INSERT INTO picking_transactions (picklist_number, product_id, location_id, qty_actual, picker_name, status, inventory_reason, description, scanned_at) 
          VALUES ($1, $2, $3, $4, $5, 'SHORTAGE', $6, $7, NOW())
        `, [picklist_number, product_id, location_id, inputQty, picker_name, inventory_reason, prodDesc]);

        // Log ke Compliance: STATUS = 'WAITING' (Sesuai permintaan agar muncul di menu komplen)
        await client.query(`
          INSERT INTO picking_compliance (picklist_number, product_id, location_id, description, qty_pick, keterangan, status_awal, status_akhir, inventory_reason) 
          VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', 'WAITING', $7)
        `, [picklist_number, product_id, location_id, prodDesc, qtyReqAsli, `Shortage: ${inputQty} pcs oleh ${picker_name}`, inventory_reason]);

        await client.query('COMMIT');
        return res.status(200).json({ status: 'success', message: 'Shortage tersinkron' });
      }

      // --- B. LOGIKA PICKING NORMAL (UPDATE QTY) ---
      if (action === 'update_qty') {
        const inputQty = parseInt(qty_actual) || 0;
        
        const checkRes = await client.query(
          `SELECT qty_pick, COALESCE(qty_actual, 0) as current FROM picklist_raw WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
          [picklist_number, product_id, location_id]
        );

        if (checkRes.rows.length > 0) {
          const item = checkRes.rows[0];
          const newTotal = item.current + inputQty;
          
          // Penentuan status: Jika sudah cukup maka 'fully picked', jika belum 'partial picked'
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
      }
    }

    // ==========================================
    // 2. AMBIL DATA (GET) - UNTUK HP PICKER
    // ==========================================
    if (req.method === 'GET') {
      const { action, picklist_number } = req.query;

      if (action === 'get_list' || !picklist_number) {
        const queryList = `
          SELECT p.picklist_number, p.nama_customer, p.status, SUM(p.qty_pick)::int AS total_qty,
          COALESCE((
              SELECT json_agg(json_build_object(
                'product_id', sub.product_id, 'description', COALESCE(mp.description, sub.product_id),
                'location_id', sub.location_id, 'qty_pick', sub.qty_pick,
                'qty_actual', COALESCE(sub.qty_actual, 0), 'sisa_qty', (sub.qty_pick - COALESCE(sub.qty_actual, 0)),
                'status', sub.status
              ))
              FROM picklist_raw sub
              LEFT JOIN master_product mp ON sub.product_id = mp.product_id
              WHERE sub.picklist_number = p.picklist_number AND sub.status NOT IN ('fully picked')
          ), '[]') as items
          FROM picklist_raw p 
          WHERE p.status IN ('Open', 'open', 'partial picked')
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.picklist_number DESC
        `;
        const result = await client.query(queryList);
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
