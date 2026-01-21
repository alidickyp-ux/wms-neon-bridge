const { Pool } = require('pg');
const QRCode = require('qrcode');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  // --- 1. CORS Headers ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, User-Agent, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action || req.body?.action;
  let client;

  try {
    client = await pool.connect();

    // ==========================================
    // 2. LOGIKA GET
    // ==========================================
    if (req.method === 'GET') {
      const pcb = req.query.pcb || req.query.picklist_number;
      const { type, container } = req.query;

      // A. LIST KERJA PACKING
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

      // B. HISTORY RE-PRINT
      if (action === 'get_history_list') {
        const result = await client.query(`
          SELECT 
            pt.picklist_number, p.nama_customer, MAX(pt.status) AS status_packing,
            COUNT(DISTINCT pt.container_number)::int AS total_box,
            SUM(pt.qty_packed)::int AS total_pcs_packed
          FROM packing_transactions pt
          JOIN (SELECT DISTINCT picklist_number, nama_customer FROM picklist_raw) p 
            ON pt.picklist_number = p.picklist_number
          GROUP BY pt.picklist_number, p.nama_customer
          ORDER BY pt.picklist_number DESC
        `);
        return res.json({ status: 'success', data: result.rows });
      }

      // C. HEADER INFO (Detail untuk Packing Activity)
      if (action === 'get_info') {
        const result = await client.query(`
          SELECT 
            p.picklist_number, p.nama_customer,
            SUM(p.qty_pick)::int AS total_qty_req,
            SUM(p.qty_actual)::int AS total_pick,
            (SELECT COALESCE(SUM(qty_packed),0)::int FROM packing_transactions WHERE picklist_number = $1) AS total_pack,
            (
              SELECT json_agg(items)
              FROM (
                SELECT 
                  sub.product_id,
                  MAX(COALESCE(mp.description, sub.product_id)) AS nama_item,
                  SUM(sub.qty_actual)::int AS qty_pick,
                  (SELECT COALESCE(SUM(qty_packed),0)::int FROM packing_transactions 
                   WHERE picklist_number = sub.picklist_number AND product_id = sub.product_id) AS qty_packed_total
                FROM picklist_raw sub
                LEFT JOIN master_product mp ON sub.product_id = mp.product_id
                WHERE sub.picklist_number = $1
                GROUP BY sub.product_id, sub.picklist_number
              ) items
            ) AS items
          FROM picklist_raw p
          WHERE p.picklist_number = $1
          GROUP BY p.picklist_number, p.nama_customer
        `, [pcb]);
        return res.json({ status: 'success', data: result.rows[0] });
      }

      // D. NEXT CONTAINER
      if (action === 'get_next_container') {
        const result = await client.query(
          `SELECT COUNT(DISTINCT container_number)::int AS total FROM packing_transactions WHERE picklist_number = $1`,
          [pcb]
        );
        const nextNum = result.rows[0].total + 1;
        const formatted = String(nextNum).padStart(3, '0');
        return res.json({ status: 'success', next_container_number: `${type}-${formatted}` });
      }

      // E. ISI LACI
      if (action === 'get_laci') {
        const list = await client.query(`
          SELECT pt.product_id, SUM(pt.qty_packed)::int AS qty_packed, MAX(COALESCE(mp.description, pt.product_id)) AS nama_item
          FROM packing_transactions pt
          LEFT JOIN master_product mp ON pt.product_id = mp.product_id
          WHERE pt.picklist_number = $1 AND (pt.container_number = $2 OR pt.box_number = $2)
          GROUP BY pt.product_id
        `, [pcb, container]);

        const huidRes = await client.query(
          `SELECT huid FROM packing_transactions WHERE picklist_number = $1 AND (container_number = $2 OR box_number = $2) LIMIT 1`,
          [pcb, container]
        );

        return res.json({
          status: 'success',
          huid: huidRes.rows[0]?.huid || '-',
          packing_list: list.rows
        });
      }

      // F. PRINT DATA + QR (Data Lengkap untuk Android)
      if (action === 'get_print_data') {
        const result = await client.query(`
          SELECT 
            pt.container_number, pt.huid, pt.container_type, pt.picklist_number,
            (SELECT nama_customer FROM picklist_raw WHERE picklist_number = pt.picklist_number LIMIT 1) AS nama_toko,
            COALESCE(pt.weight_kg, 0)::float AS weight_kg,
            SUM(pt.qty_packed)::int AS total_pcs_box,
            MAX(pt.scanned_by) AS packer_name,
            (
              SELECT json_agg(items)
              FROM (
                SELECT 
                  sub.product_id AS sku, 
                  MAX(COALESCE(mp.description, sub.product_id)) AS nama_item,
                  SUM(sub.qty_packed)::int AS qty
                FROM packing_transactions sub
                LEFT JOIN master_product mp ON sub.product_id = mp.product_id
                WHERE sub.picklist_number = pt.picklist_number AND sub.container_number = pt.container_number
                GROUP BY sub.product_id
              ) items
            ) AS item_details
          FROM packing_transactions pt
          WHERE pt.picklist_number = $1
          GROUP BY pt.picklist_number, pt.container_number, pt.huid, pt.container_type, pt.weight_kg
          ORDER BY pt.container_number
        `, [pcb]);

        const enriched = await Promise.all(
          result.rows.map(async (row) => {
            const qr = await QRCode.toDataURL(row.huid, { width: 400, margin: 2 });
            return { ...row, qr_code_image: qr };
          })
        );
        return res.json({ status: 'success', data: enriched });
      }
    } // END GET

    // ==========================================
    // 3. LOGIKA POST
    // ==========================================
    if (req.method === 'POST') {
      const { picklist_number, product_id, qty_packed, container_number, container_type, scanned_by, weight_kg, pcb: pcbPost, container: contPost } = req.body;

      // G. SAVE ITEM
      if (action === 'save_item') {
        const check = await client.query(
          `SELECT huid FROM packing_transactions WHERE picklist_number = $1 AND container_number = $2 LIMIT 1`,
          [picklist_number, container_number]
        );

        const huid = check.rows[0]?.huid || `${picklist_number.slice(-5)}${Date.now().toString().slice(-8)}`;

        await client.query(`
          INSERT INTO packing_transactions (huid, picklist_number, product_id, qty_packed, scanned_by, container_number, box_number, container_type, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Packing')
        `, [huid, picklist_number, product_id, qty_packed, scanned_by, container_number, container_number, container_type]);

        return res.json({ status: 'success', message: 'Item saved', huid });
      }

      // H. CLOSE BOX
      if (action === 'close_box') {
        const finalPcb = pcbPost || picklist_number;
        const finalCont = contPost || container_number;
        await client.query(
          `UPDATE packing_transactions SET status = 'Closed', weight_kg = $1 WHERE picklist_number = $2 AND container_number = $3`,
          [weight_kg, finalPcb, finalCont]
        );
        return res.json({ status: 'success', message: 'Box Closed' });
      }
    } // END POST

  } catch (err) {
    console.error('PACKING ERROR:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
