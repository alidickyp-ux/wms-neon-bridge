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
      // 1. Ambil Daftar PCB (Halaman 0)
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

      // 2. Ambil Info Detail PCB (Halaman 1)
      if (action === 'get_info') {
        const result = await client.query(`
          SELECT p.picklist_number, p.nama_customer, 
          COUNT(p.product_id)::int AS total_qty_req,
          SUM(p.qty_actual)::int AS total_pick,
          (SELECT COALESCE(SUM(qty_packed), 0)::int FROM packing_transactions WHERE picklist_number = $1) AS total_pack
          FROM picklist_raw p WHERE p.picklist_number = $1
          GROUP BY p.picklist_number, p.nama_customer
        `, [pcb]);
        return res.status(200).json({ status: 'success', data: result.rows[0] });
      }

      // 3. Ambil Nomor Box Berikutnya (BOX-001)
      if (action === 'get_next_container') {
        const result = await client.query(`
          SELECT COUNT(DISTINCT container_number) + 1 AS next_num 
          FROM packing_transactions WHERE picklist_number = $1
        `, [pcb]);
        const nextNum = String(result.rows[0].next_num).padStart(3, '0');
        return res.status(200).json({ status: 'success', next_container_number: `${type}-${nextNum}` });
      }

      // 4. Ambil Isi Laci (Halaman 2)
      if (action === 'get_laci') {
        const list = await client.query("SELECT huid, product_id, qty_packed FROM packing_transactions WHERE picklist_number = $1 AND container_number = $2", [pcb, container]);
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
    
    const huid = `${picklist_number}-${Date.now()}`;

    // Kita masukkan container_number ke dalam kolom box_number juga agar tidak NULL
    await client.query(`
      INSERT INTO packing_transactions 
      (huid, picklist_number, product_id, qty_packed, container_number, box_number, container_type, scanned_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
        huid, 
        picklist_number, 
        product_id, 
        qty_packed, 
        container_number, 
        container_number, // Ini untuk kolom box_number (mengisi nilai yang sama)
        container_type, 
        scanned_by, 
        'Packing' // Memberikan status awal
    ]);

    return res.status(200).json({ status: 'success', message: 'Item saved' });
  }
      
      // ... sisanya

      if (action === 'close_box') {
        // Implementasi simpan berat jika tabel sudah ada, jika belum hanya sukses
        return res.status(200).json({ status: 'success', message: 'Box Closed' });
      }
    }
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (client) client.release();
  }
};
