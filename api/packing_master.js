const { Pool } = require('pg');
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

module.exports = async (req, res) => {
  const { action, pcb, type, container } = req.query;
  let client;

  try {
    client = await pool.connect();

    if (req.method === 'GET') {
      if (action === 'get_list') {
        const result = await client.query(`
          SELECT picklist_number, nama_customer, status AS status_picklist,
          COUNT(product_id)::int AS total_sku,
          CAST(COALESCE(SUM(qty_actual), 0) AS INTEGER) AS total_pcs_picked
          FROM picklist_raw 
          WHERE LOWER(status) IN ('partial picked', 'fully picked')
          GROUP BY picklist_number, nama_customer, status
          ORDER BY picklist_number DESC
        `);
        return res.status(200).json({ status: 'success', data: result.rows });
      }

      if (action === 'get_info') {
        const result = await client.query(`
          SELECT 
            p.picklist_number, 
            p.nama_customer, 
            CAST(SUM(p.qty_pick) AS INTEGER) AS total_qty_req, 
            CAST(SUM(p.qty_actual) AS INTEGER) AS total_pick, 
            (SELECT COALESCE(SUM(qty_packed), 0)::int FROM packing_transactions WHERE picklist_number = $1) AS total_pack,
            -- AMBIL DETAIL ITEM UNTUK DESKRIPSI DI ANDROID
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'product_id', p.product_id, 
                'nama_item', p.nama_item, 
                'qty_pick', p.qty_actual
              )
            ) as items
          FROM picklist_raw p 
          WHERE p.picklist_number = $1
          GROUP BY p.picklist_number, p.nama_customer
        `, [pcb]);
        return res.status(200).json({ status: 'success', data: result.rows[0] });
      }

      if (action === 'get_next_container') {
        const result = await client.query(`
          SELECT COUNT(DISTINCT container_number) + 1 AS next_num 
          FROM packing_transactions WHERE picklist_number = $1
        `, [pcb]);
        const nextNum = String(result.rows[0].next_num).padStart(3, '0');
        return res.status(200).json({ status: 'success', next_container_number: `${type}-${nextNum}` });
      }

      if (action === 'get_laci') {
        // JOIN DENGAN picklist_raw UNTUK DAPAT NAMA ITEM DI LACI
        const list = await client.query(`
          SELECT pt.huid, pt.product_id, pt.qty_packed, pr.nama_item 
          FROM packing_transactions pt
          LEFT JOIN picklist_raw pr ON pt.product_id = pr.product_id AND pt.picklist_number = pr.picklist_number
          WHERE pt.picklist_number = $1 AND pt.container_number = $2
        `, [pcb, container]);
        
        const total = await client.query("SELECT SUM(qty_packed)::int as total FROM packing_transactions WHERE container_number = $1", [container]);
        
        return res.status(200).json({ 
          status: 'success', 
          container_info: { container_number: container, total_pcs: total.rows[0].total || 0 },
          packing_list: list.rows 
        });
      }
    }

    if (req.method === 'POST') {
      if (action === 'save_item') {
        const { picklist_number, product_id, qty_packed, container_number, container_type, scanned_by } = req.body;
        
        // --- LOGIKA HUID KONSISTEN PER BOX ---
        // Cek apakah box ini sudah punya HUID sebelumnya
        const checkExistingHuid = await client.query(
            "SELECT huid FROM packing_transactions WHERE picklist_number = $1 AND container_number = $2 LIMIT 1",
            [picklist_number, container_number]
        );

        let huid;
        if (checkExistingHuid.rows.length > 0) {
            huid = checkExistingHuid.rows[0].huid; // Pakai HUID yang sudah ada
        } else {
            // Jika box benar-benar baru, generate HUID baru
            const pcbSuffix = picklist_number.slice(-5);
            const now = new Date();
            const year = now.getFullYear().toString().slice(-2);
            const day = now.getDate().toString().padStart(2, '0');
            const month = (now.getMonth() + 1).toString().padStart(2, '0');
            const datePart = `${year}${day}${month}`;
            const randomPart = Math.floor(1000 + Math.random() * 9000); 
            huid = `${pcbSuffix}${datePart}${randomPart}`;
        }

        await client.query(`
          INSERT INTO packing_transactions 
          (huid, picklist_number, product_id, qty_packed, container_number, box_number, container_type, scanned_by, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [huid, picklist_number, product_id, qty_packed, container_number, container_number, container_type, scanned_by, 'Packing']);

        return res.status(200).json({ status: 'success', message: 'Item saved', huid: huid });
      }

      if (action === 'close_box') {
        const { pcb, container, weight_kg } = req.body;
        await client.query(`
          UPDATE packing_transactions 
          SET weight_kg = $1, status = 'Closed' 
          WHERE picklist_number = $2 AND container_number = $3
        `, [weight_kg, pcb, container]);
        return res.status(200).json({ status: 'success', message: 'Box Closed' });
      }
    }
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
