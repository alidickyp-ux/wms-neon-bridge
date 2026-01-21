const { Pool } = require('pg');

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

module.exports = async (req, res) => {
  // --- 1. GERBANG CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, User-Agent, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body.action;
  let client;

  try {
    client = await pool.connect();

    // ==========================================
    // 2. LOGIKA GET (AMBIL DATA)
    // ==========================================
    if (req.method === 'GET') {
      const { pcb, type, container } = req.query;

      // A. LIST KERJA PACKING
      if (action === 'get_list') {
        const result = await client.query(`
          SELECT p.picklist_number, p.nama_customer, p.status, 
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
          SELECT pt.picklist_number, p.nama_customer, MAX(pt.status) AS status_packing, 
          COUNT(DISTINCT pt.container_number)::int AS total_box, 
          SUM(pt.qty_packed)::int AS total_pcs_packed 
          FROM packing_transactions pt 
          JOIN (SELECT DISTINCT picklist_number, nama_customer FROM picklist_raw) p ON pt.picklist_number = p.picklist_number 
          GROUP BY pt.picklist_number, p.nama_customer 
          ORDER BY pt.picklist_number DESC
        `);
        return res.json({ status: 'success', data: result.rows });
      }

      // C. INFO HEADER & DAFTAR SKU (MASTER VALIDASI)
      if (action === 'get_info') {
        const result = await client.query(`
          SELECT 
            p.picklist_number, p.nama_customer, 
            SUM(p.qty_pick)::int AS total_qty_req, 
            SUM(p.qty_actual)::int AS total_pick, 
            (SELECT COALESCE(SUM(qty_packed),0)::int FROM packing_transactions WHERE picklist_number = $1) AS total_pack,
            (
              SELECT json_agg(item_list) FROM (
                SELECT sub.product_id, MAX(COALESCE(mp.description, sub.product_id)) as nama_item,
                SUM(sub.qty_actual)::int as qty_pick,
                (SELECT COALESCE(SUM(qty_packed), 0)::int FROM packing_transactions 
                 WHERE picklist_number = sub.picklist_number AND product_id = sub.product_id) as qty_packed_total
                FROM picklist_raw sub
                LEFT JOIN master_product mp ON sub.product_id = mp.product_id
                WHERE sub.picklist_number = $1
                GROUP BY sub.product_id, sub.picklist_number
              ) item_list
            ) as items
          FROM picklist_raw p WHERE p.picklist_number = $1 GROUP BY p.picklist_number, p.nama_customer
        `, [pcb]);
        return res.json({ status: 'success', data: result.rows[0] });
      }

      // D. AUTO-INCREMENT NOMOR WADAH
      if (action === 'get_next_container') {
        const result = await client.query(`
          SELECT COUNT(DISTINCT container_number) as total 
          FROM packing_transactions 
          WHERE picklist_number = $1
        `, [pcb]);
        const nextNum = parseInt(result.rows[0].total) + 1;
        const formattedNum = String(nextNum).padStart(3, '0');
        return res.json({ status: 'success', next_container_number: `${type}-${formattedNum}` });
      }

      // E. ISI DALAM WADAH (LACI)
if (action === 'get_laci') {
        const { pcb, container } = req.query; // Pastikan ambil dari query
        
        const list = await client.query(`
          SELECT 
            pt.product_id, 
            SUM(pt.qty_packed)::int AS qty_packed, 
            MAX(COALESCE(mp.description, pt.product_id)) AS nama_item 
          FROM packing_transactions pt 
          LEFT JOIN master_product mp ON pt.product_id = mp.product_id 
          WHERE pt.picklist_number = $1 
            AND (pt.container_number = $2 OR pt.box_number = $2) 
          GROUP BY pt.product_id
        `, [pcb, container]);
        
        const huidRes = await client.query(`
          SELECT huid FROM packing_transactions 
          WHERE picklist_number = $1 AND (container_number = $2 OR box_number = $2)
          LIMIT 1
        `, [pcb, container]);
        
        return res.json({ 
          status: 'success', 
          huid: huidRes.rows[0]?.huid || '-', 
          packing_list: list.rows 
        });
      }

      // F. DATA PRINT (RE-PRINT LABEL)
if (action === 'get_print_data') {
        const result = await client.query(`
          SELECT 
            pt.container_number, pt.huid, pt.container_type, pt.picklist_number,
            (SELECT nama_customer FROM picklist_raw WHERE picklist_number = pt.picklist_number LIMIT 1) as nama_toko,
            COALESCE(CAST(pt.weight_kg AS FLOAT), 0) as weight_kg,
            CAST(SUM(pt.qty_packed) AS INTEGER) as total_pcs_box,
            (
              SELECT json_agg(json_build_object(
                'sku', sub.product_id, 
                'desc', COALESCE(mp.description, sub.product_id), 
                'qty', sub.qty_packed
              ))
              FROM packing_transactions sub 
              LEFT JOIN master_product mp ON sub.product_id = mp.product_id
              WHERE sub.picklist_number = pt.picklist_number 
                AND sub.container_number = pt.container_number
            ) as item_details,
            MAX(pt.scanned_by) as packer_name
          FROM packing_transactions pt 
          WHERE pt.picklist_number = $1
          GROUP BY pt.picklist_number, pt.container_number, pt.huid, pt.container_type, pt.weight_kg
          ORDER BY pt.container_number ASC
        `, [pcb]);

        // Tambahkan format teks QR untuk setiap box
        const enrichedData = await Promise.all(result.rows.map(async (row) => {
          // FORMAT QR SESUAI GAMBAR ANDA
          const qrText = 
            `BOX: ${row.huid} | ${row.nama_toko}\n` +
            `PCB: ${row.picklist_number}\n` +
            `--------------------------\n` +
            `LIST ITEM:\n` +
            row.item_details.map(i => `${i.sku} | ${i.desc} | ${i.qty} PCS`).join('\n') +
            `\n--------------------------\n` +
            `TOTAL  : ${row.total_pcs_box} PCS\n` +
            `WEIGHT : ${row.weight_kg} KG\n` +
            `PACKER : ${row.packer_name}`;

          // Generate Base64 QR Image agar bisa langsung tampil di App/Web
          const qrImageBase64 = await QRCode.toDataURL(qrText, { margin: 2, width: 400 });

          return { ...row, qr_text_content: qrText, qr_code_image: qrImageBase64 };
        }));

        return res.json({ status: 'success', data: enrichedData });
      }
    }

    // ==========================================
    // 3. LOGIKA POST (SIMPAN DATA)
    // ==========================================
    if (req.method === 'POST') {
      const { picklist_number, product_id, qty_packed, container_number, container_type, scanned_by, pcb: pcbPost, container: contPost, weight_kg } = req.body;

      // G. SAVE ITEM TO BOX
if (action === 'save_item') {
        // 1. Cek HUID (Tetap satu box satu HUID)
        const huidCheck = await client.query(
          `SELECT huid FROM packing_transactions WHERE picklist_number = $1 AND container_number = $2 LIMIT 1`, 
          [picklist_number, container_number]
        );
        
        let huid = huidCheck.rows[0]?.huid;
        if (!huid) {
          const suffix = picklist_number.slice(-5);
          huid = `${suffix}${new Date().getTime().toString().slice(-8)}`;
        }

        // 2. INSERT (Gue tambahin kolom box_number sesuai error lu)
        await client.query(`
          INSERT INTO packing_transactions (
            huid, 
            picklist_number, 
            product_id, 
            qty_packed, 
            scanned_by, 
            container_number, 
            box_number, 
            container_type, 
            status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Packing')
        `, [
          huid,              // $1
          picklist_number,   // $2
          product_id,        // $3
          qty_packed,        // $4
          scanned_by,        // $5
          container_number,  // $6 (Ini container_number)
          container_number,  // $7 (Ini box_number - Kita isi sama biar gak null)
          container_type     // $8
        ]);

        return res.json({ status: 'success', message: 'Item saved to box', huid });
      }

      // H. CLOSE BOX (SELESAI TIMBANG)
      if (action === 'close_box') {
        const finalPcb = pcbPost || picklist_number;
        const finalCont = contPost || container_number;
        await client.query(`
          UPDATE packing_transactions SET status = 'Closed', weight_kg = $1 
          WHERE picklist_number = $2 AND container_number = $3
        `, [weight_kg, finalPcb, finalCont]);
        return res.json({ status: 'success', message: 'Box Closed' });
      }
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
