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
      
      // 1. AMBIL DAFTAR PCB UNTUK HALAMAN UTAMA PACKING
      if (action === 'get_list') {
        const result = await client.query(`
          SELECT 
            p.picklist_number, 
            p.nama_customer, 
            p.status,
            COUNT(DISTINCT p.product_id)::int AS total_sku,
            SUM(p.qty_actual)::int AS total_pcs_picked, -- Menampilkan berapa yang sudah di-pick
            json_agg(
              json_build_object(
                'product_id', p.product_id,
                'description', COALESCE(mp.description, p.product_id),
                'location_id', p.location_id,
                'qty_pick', p.qty_pick,
                'qty_actual', p.qty_actual,
                'status', p.status
              )
            ) AS items
          FROM picklist_raw p
          LEFT JOIN master_product mp ON p.product_id = mp.product_id
          WHERE LOWER(p.status) IN ('fully picked', 'partial picked')
          GROUP BY p.picklist_number, p.nama_customer, p.status
          ORDER BY p.picklist_number DESC
        `);
        return res.status(200).json({ status: 'success', data: result.rows });
      }

      // 2. AMBIL INFO DETAIL UNTUK HEADER EKSEKUSI (REQ, PICK, PACK)

// --- BAGIAN GET_INFO YANG SUDAH DI-FIX TOTAL ---
if (action === 'get_info') {
    const result = await client.query(`
        SELECT 
            p.picklist_number, 
            p.nama_customer, 
            -- REQ: Total qty yang seharusnya di-pick (Planning)
            CAST(SUM(COALESCE(p.qty_pick, 0)) AS INTEGER) AS total_qty_req, 
            -- PICK: Menjumlahkan SEMUA qty_actual dari SEMUA baris (Normal & Shortage)
            CAST(SUM(COALESCE(p.qty_actual, 0)) AS INTEGER) AS total_pick, 
            -- PACK: Total qty yang sudah masuk ke transaksi packing
            (SELECT COALESCE(SUM(qty_packed), 0)::int FROM packing_transactions WHERE picklist_number = $1) AS total_pack,
            
            -- ITEMS: List barang untuk validasi SKU di Android (DIBUNGKUS AGAR TIDAK DUPLIKAT)
            (
                SELECT json_agg(item_group)
                FROM (
                    SELECT 
                        sub.product_id,
                        MAX(COALESCE(mp.description, sub.product_id)) as nama_item,
                        -- SUM qty_actual dari semua lokasi (Mau dia Normal atau Shortage)
                        SUM(COALESCE(sub.qty_actual, 0))::int as qty_pick,
                        -- SUM qty_packed yang sudah sukses masuk box
                        (
                            SELECT COALESCE(SUM(qty_packed), 0)::int 
                            FROM packing_transactions 
                            WHERE picklist_number = sub.picklist_number AND product_id = sub.product_id
                        ) as qty_packed_total
                    FROM picklist_raw sub
                    LEFT JOIN master_product mp ON sub.product_id = mp.product_id
                    WHERE sub.picklist_number = $1
                    GROUP BY sub.product_id, sub.picklist_number
                ) item_group
            ) as items
        FROM picklist_raw p 
        WHERE p.picklist_number = $1
        GROUP BY p.picklist_number, p.nama_customer
    `, [pcb]);

    if (result.rows.length === 0) {
        return res.status(404).json({ status: 'error', message: 'Data tidak ditemukan' });
    }

    return res.status(200).json({ status: 'success', data: result.rows[0] });
}

      // 3. GENERATE NOMOR CONTAINER BERIKUTNYA
      if (action === 'get_next_container') {
        const result = await client.query(`
          SELECT COUNT(DISTINCT container_number) + 1 AS next_num 
          FROM packing_transactions WHERE picklist_number = $1
        `, [pcb]);
        const nextNum = String(result.rows[0].next_num).padStart(3, '0');
        return res.status(200).json({ status: 'success', next_container_number: `${type}-${nextNum}` });
      }

      // 4. AMBIL ISI LACI (DENGAN GROUPING SKU & HUID TUNGGAL)
      if (action === 'get_laci') {
        // Ambil list item yang di-SUM per SKU agar tidak double baris
        const list = await client.query(`
          SELECT 
            pt.product_id, 
            SUM(pt.qty_packed)::int as qty_packed, 
            COALESCE(mp.description, pt.product_id) as nama_item 
          FROM packing_transactions pt
          LEFT JOIN master_product mp ON pt.product_id = mp.product_id
          WHERE pt.picklist_number = $1 AND pt.container_number = $2
          GROUP BY pt.product_id, mp.description
        `, [pcb, container]);
        
        // Ambil HUID tunggal untuk container ini
        const huidRes = await client.query(`
          SELECT huid FROM packing_transactions 
          WHERE picklist_number = $1 AND container_number = $2 
          LIMIT 1
        `, [pcb, container]);

        const total = await client.query(`
          SELECT SUM(qty_packed)::int as total 
          FROM packing_transactions 
          WHERE container_number = $1 AND picklist_number = $2
        `, [container, pcb]);
        
        return res.status(200).json({ 
          status: 'success', 
          huid: huidRes.rows.length > 0 ? huidRes.rows[0].huid : "-",
          container_info: { container_number: container, total_pcs: total.rows[0].total || 0 },
          packing_list: list.rows 
        });
      }
    }

    if (req.method === 'POST') {
      // 5. SIMPAN BARANG KE DALAM BOX (PACKING)
      if (action === 'save_item') {
        const { picklist_number, product_id, qty_packed, container_number, container_type, scanned_by } = req.body;
        
        const checkHuid = await client.query(
          "SELECT huid FROM packing_transactions WHERE picklist_number = $1 AND container_number = $2 LIMIT 1",
          [picklist_number, container_number]
        );

        let huid;
        if (checkHuid.rows.length > 0) {
          huid = checkHuid.rows[0].huid; 
        } else {
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Packing')
        `, [huid, picklist_number, product_id, qty_packed, container_number, container_number, container_type, scanned_by]);

        return res.status(200).json({ status: 'success', message: 'Item saved', huid: huid });
      }

      // 6. TUTUP BOX (INPUT BERAT)
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
    console.error("ERROR PACKING MASTER:", err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
