const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

module.exports = async (req, res) => {

  // ==========================
  // 1. GERBANG CORS
  // ==========================
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, User-Agent, Accept, X-Requested-With'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body.action;
  const { pcb, type, container } = req.query;
  let client;

  try {
    client = await pool.connect();

    // ==========================================
    // 2. GET
    // ==========================================
    if (req.method === 'GET') {

      if (action === 'get_list') {
        const result = await client.query(`
          SELECT 
            p.picklist_number, p.nama_customer, p.status,
            COUNT(DISTINCT p.product_id)::int AS total_sku,
            SUM(p.qty_actual)::int AS total_pcs_picked
          FROM picklist_raw p
          WHERE LOWER(p.status) IN ('fully picked', 'partial picked')
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.picklist_number DESC
        `);
        return res.json({ status: 'success', data: result.rows });
      }

      if (action === 'get_history_list') {
        const result = await client.query(`
          SELECT 
            pt.picklist_number, p.nama_customer,
            MAX(pt.status) AS status_packing,
            COUNT(DISTINCT pt.container_number)::int AS total_box,
            SUM(pt.qty_packed)::int AS total_pcs_packed
          FROM packing_transactions pt
          JOIN (
            SELECT DISTINCT picklist_number, nama_customer 
            FROM picklist_raw
          ) p ON pt.picklist_number = p.picklist_number
          GROUP BY pt.picklist_number, p.nama_customer
          ORDER BY pt.picklist_number DESC
        `);
        return res.json({ status: 'success', data: result.rows });
      }

      if (action === 'get_info') {
        const result = await client.query(`
          SELECT 
            p.picklist_number, p.nama_customer,
            SUM(p.qty_pick)::int AS total_qty_req,
            SUM(p.qty_actual)::int AS total_pick,
            (
              SELECT COALESCE(SUM(qty_packed),0)::int
              FROM packing_transactions
              WHERE picklist_number = $1
            ) AS total_pack
          FROM picklist_raw p
          WHERE p.picklist_number = $1
          GROUP BY p.picklist_number, p.nama_customer
        `, [pcb]);

        return res.json({ status: 'success', data: result.rows[0] });
      }

      if (action === 'get_next_container') {
        const result = await client.query(`
          SELECT COUNT(DISTINCT container_number) + 1 AS next_num
          FROM packing_transactions
          WHERE picklist_number = $1
        `, [pcb]);

        const nextNum = String(result.rows[0].next_num).padStart(3, '0');
        return res.json({
          status: 'success',
          next_container_number: `${type}-${nextNum}`
        });
      }

      if (action === 'get_laci') {
        const list = await client.query(`
          SELECT 
            pt.product_id,
            SUM(pt.qty_packed)::int AS qty_packed,
            COALESCE(mp.description, pt.product_id) AS nama_item
          FROM packing_transactions pt
          LEFT JOIN master_product mp ON pt.product_id = mp.product_id
          WHERE pt.picklist_number = $1
            AND pt.container_number = $2
          GROUP BY pt.product_id, mp.description
        `, [pcb, container]);

        const huidRes = await client.query(`
          SELECT huid FROM packing_transactions
          WHERE picklist_number = $1
            AND container_number = $2
          LIMIT 1
        `, [pcb, container]);

        return res.json({
          status: 'success',
          huid: huidRes.rows[0]?.huid || '-',
          packing_list: list.rows
        });
      }
    }

    // ==========================================
    // 3. POST
    // ==========================================
    if (req.method === 'POST') {

      const {
        picklist_number,
        product_id,
        qty_packed,
        container_number,
        container_type,
        scanned_by,
        pcb: pcbPost,
        container: contPost,
        weight_kg
      } = req.body;

      // ======================================
      // G. SAVE ITEM (FIXED TOTAL)
      // ======================================
      if (action === 'save_item') {

        // 1️⃣ CEK BOX SUDAH CLOSED ATAU BELUM
        const boxStatus = await client.query(`
          SELECT status FROM packing_transactions
          WHERE picklist_number = $1
            AND container_number = $2
          LIMIT 1
        `, [picklist_number, container_number]);

        if (boxStatus.rows[0]?.status === 'Closed') {
          return res.status(400).json({
            status: 'error',
            message: 'Box sudah Closed, tidak bisa tambah item'
          });
        }

        // 2️⃣ TOTAL PICKED SKU
        const pickedRes = await client.query(`
          SELECT COALESCE(SUM(qty_actual),0)::int AS total_picked
          FROM picking_transactions
          WHERE picklist_number = $1
            AND product_id = $2
        `, [picklist_number, product_id]);

        // 3️⃣ TOTAL SUDAH DIPACK
        const packedRes = await client.query(`
          SELECT COALESCE(SUM(qty_packed),0)::int AS total_packed
          FROM packing_transactions
          WHERE picklist_number = $1
            AND product_id = $2
        `, [picklist_number, product_id]);

        const totalPicked = pickedRes.rows[0].total_picked;
        const totalPacked = packedRes.rows[0].total_packed;

        if (totalPacked + qty_packed > totalPicked) {
          return res.status(400).json({
            status: 'error',
            message: `Qty packing melebihi qty picked (${totalPacked}/${totalPicked})`
          });
        }

        // 4️⃣ HUID (SATU BOX = SATU HUID)
        const huidCheck = await client.query(`
          SELECT huid FROM packing_transactions
          WHERE picklist_number = $1
            AND container_number = $2
          LIMIT 1
        `, [picklist_number, container_number]);

        let huid = huidCheck.rows[0]?.huid;
        if (!huid) {
          const suffix = picklist_number.slice(-5);
          const now = new Date();
          const datePart =
            now.getFullYear().toString().slice(-2) +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0');
          huid = `${suffix}${datePart}${Math.floor(1000 + Math.random() * 9000)}`;
        }

        // 5️⃣ INSERT
        await client.query(`
          INSERT INTO packing_transactions
          (huid, picklist_number, product_id, qty_packed, container_number, container_type, scanned_by, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'Packing')
        `, [
          huid,
          picklist_number,
          product_id,
          qty_packed,
          container_number,
          container_type,
          scanned_by
        ]);

        return res.json({
          status: 'success',
          message: 'Item berhasil masuk box',
          huid
        });
      }

      // ======================================
      // H. CLOSE BOX
      // ======================================
      if (action === 'close_box') {
        await client.query(`
          UPDATE packing_transactions
          SET status = 'Closed',
              weight_kg = $1
          WHERE picklist_number = $2
            AND container_number = $3
        `, [weight_kg, pcbPost, contPost]);

        return res.json({
          status: 'success',
          message: 'Box berhasil ditutup'
        });
      }
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
