const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

module.exports = async (req, res) => {
  // --- 1. GERBANG CORS (Kunci Biar Gak 401) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, User-Agent, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Ambil action secara fleksibel (Query untuk GET, Body untuk POST)
  const action = req.query.action || req.body.action;
  const { pcb, type, container } = req.query;
  let client;

  try {
    client = await pool.connect();

    // ==========================================
    // 2. LOGIKA AMBIL DATA (GET)
    // ==========================================
    if (req.method === 'GET') {
      
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
        return res.status(200).json({ status: 'success', data: result.rows });
      }

      // B. LIST HISTORY RE-PRINT (Fitur Baru)
      if (action === 'get_history_list') {
        const result = await client.query(`
          SELECT 
            pt.picklist_number, p.nama_customer, 
            MAX(pt.status) as status_packing,
            COUNT(DISTINCT pt.container_number)::int AS total_box,
            SUM(pt.qty_packed)::int AS total_pcs_packed
          FROM packing_transactions pt
          JOIN (SELECT DISTINCT picklist_number, nama_customer FROM picklist_raw) p 
            ON pt.picklist_number = p.picklist_number
          GROUP BY pt.picklist_number, p.nama_customer
          ORDER BY pt.picklist_number DESC
        `);
        return res.status(200).json({ status: 'success', data: result.rows });
      }

      // C. HEADER INFO DETAIL
      if (action === 'get_info') {
        const result = await client.query(`
          SELECT 
            p.picklist_number, p.nama_customer, 
            CAST(SUM(COALESCE(p.qty_pick, 0)) AS INTEGER) AS total_qty_req, 
            CAST(SUM(COALESCE(p.qty_actual, 0)) AS INTEGER) AS total_pick, 
            (SELECT COALESCE(SUM(qty_packed), 0)::int FROM packing_transactions WHERE picklist_number = $1) AS total_pack,
            (
              SELECT json_agg(item_group)
              FROM (
                SELECT 
                  sub.product_id,
                  MAX(COALESCE(mp.description, sub.product_id)) as nama_item,
                  SUM(COALESCE(sub.qty_actual, 0))::int as qty_pick,
                  (SELECT COALESCE(SUM(qty_packed), 0)::int FROM packing_transactions 
                   WHERE picklist_number = sub.picklist_number AND product_id = sub.product_id) as qty_packed_total
                FROM picklist_raw sub
                LEFT JOIN master_product mp ON sub.product_id = mp.product_id
                WHERE sub.picklist_number = $1
                GROUP BY sub.product_id, sub.picklist_number
              ) item_group
            ) as items
          FROM picklist_raw p WHERE p.picklist_number = $1
          GROUP BY p.picklist_number, p.nama_customer
        `, [pcb]);
        return res.status(200).json({ status: 'success', data: result.rows[0] });
      }

      // D. GENERATE NOMOR WADAH
      if (action === 'get_next_container') {
        const result = await client.query(`
          SELECT COUNT(DISTINCT container_number) + 1 AS next_num 
          FROM packing_transactions WHERE picklist_number = $1
        `, [pcb]);
        const nextNum = String(result.rows[0].next_num).padStart(3, '0');
        return res.status(200).json({ status: 'success', next_container_number: `${type}-${nextNum}` });
      }

      // E. ISI LACI/CONTAINER
      if (action === 'get_laci') {
        const list = await client.query(`
          SELECT pt.product_id, SUM(pt.qty_packed)::int as qty_packed, 
                 COALESCE(mp.description, pt.product_id) as nama_item 
          FROM packing_transactions pt
          LEFT JOIN master_product mp ON pt.product_id = mp.product_id
          WHERE pt.picklist_number = $1 AND pt.container_number = $2
          GROUP BY pt.product_id, mp.description
        `, [pcb, container]);
        const huidRes = await client.query(`SELECT huid FROM packing_transactions WHERE picklist_number = $1 AND container_number = $2 LIMIT 1`, [pcb, container]);
        return res.status(200).json({ status: 'success', huid: huidRes.rows[0]?.huid || "-", packing_list: list.rows });
      }

      // F. DATA RE-PRINT (Detail Box)
      if (action === 'get_print_data') {
        const result = await client.query(`
          SELECT 
            container_number, huid, container_type, CAST(weight_kg AS FLOAT) as weight_kg,
            CAST(SUM(qty_packed) AS INTEGER) as total_pcs_box,
            (SELECT json_agg(json_build_object('product_id', sub.product_id, 'nama_item', COALESCE(mp.description, sub.product_id), 'qty', sub.qty_packed))
             FROM packing_transactions sub LEFT JOIN master_product mp ON sub.product_id = mp.product_id
             WHERE sub.picklist_number = pt.picklist_number AND sub.container_number = pt.container_number) as item_details
          FROM packing_transactions pt
          WHERE pt.picklist_number = $1
          GROUP BY pt.picklist_number, pt.container_number, pt.huid, pt.container_type, pt.weight_kg
          ORDER BY pt.container_number ASC
        `, [pcb]);
        return res.status(200).json({ status: 'success', data: result.rows });
      }
    }

    // ==========================================
    // 3. LOGIKA SIMPAN DATA (POST)
    // ==========================================
    if (req.method === 'POST') {
      const { picklist_number, product_id, qty_packed, container_number, container_type, scanned_by, pcb: pcbPost, container: contPost, weight_kg } = req.body;

      // G. SAVE ITEM
      if (action === 'save_item') {
        const checkHuid = await client.query("SELECT huid FROM packing_transactions WHERE picklist_number = $1 AND container_number = $2 LIMIT 1", [picklist_number, container_number]);
        let huid = checkHuid.rows[0]?.huid;
        if (!huid) {
          const pcbSuffix = picklist_number.slice(-5);
          const now = new Date();
          const datePart = `${now.getFullYear().toString().slice(-2)}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
          huid = `${pcbSuffix}${datePart}${Math.floor(1000 + Math.random() * 9000)}`;
        }
        await client.query(`INSERT INTO packing_transactions (huid, picklist_number, product_id, qty_packed, container_number, container_type, scanned_by, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Packing')`, [huid, picklist_number, product_id, qty_packed, container_number, container_type, scanned_by]);
        return res.status(200).json({ status: 'success', message: 'Item saved', huid: huid });
      }

      // H. CLOSE BOX
      if (action === 'close_box') {
        await client.query(`UPDATE packing_transactions SET weight_kg = $1, status = 'Closed' WHERE picklist_number = $2 AND container_number = $3`, [weight_kg, pcbPost, contPost]);
        return res.status(200).json({ status: 'success', message: 'Box Closed' });
      }
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
