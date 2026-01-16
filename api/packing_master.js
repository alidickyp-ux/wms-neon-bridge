const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  const { action } = req.query; 
  let client;

  try {
    client = await pool.connect();

    // --- LOGIKA GET (AMBIL DATA) ---
    if (req.method === 'GET') {
      // 1. Ambil Daftar PCB
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
      
      // 2. Ambil Info Detail PCB (Halaman Eksekusi)
      if (action === 'get_info') {
        const { pcb } = req.query;
        const result = await client.query(`
          SELECT picklist_number, nama_customer, 
          COUNT(product_id)::int AS total_qty_req,
          SUM(qty_actual)::int AS total_pick,
          0 AS total_pack -- Sementara hardcode 0 atau sesuaikan query laci
          FROM picklist_raw WHERE picklist_number = $1
          GROUP BY picklist_number, nama_customer
        `, [pcb]);
        return res.status(200).json({ status: 'success', data: result.rows[0] });
      }

      // 3. Ambil List Isi Laci
      if (action === 'get_laci') {
        const { container } = req.query;
        const list = await client.query("SELECT * FROM packing_transactions WHERE container_number = $1", [container]);
        return res.status(200).json({ status: 'success', packing_list: list.rows });
      }
    }

    // --- LOGIKA POST (SIMPAN DATA) ---
    if (req.method === 'POST') {
      // 4. Simpan Scan Packing
      if (action === 'save_item') {
        const { picklist_number, product_id, qty_packed, container_number, container_type, packer_name } = req.body;
        const huid = `${picklist_number}-${Date.now()}`;
        await client.query(`
          INSERT INTO packing_transactions (huid, picklist_number, product_id, qty_packed, container_number, container_type, packer_name)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [huid, picklist_number, product_id, qty_packed, container_number, container_type, packer_name]);
        return res.status(200).json({ status: 'success', message: 'Item saved' });
      }

      // 5. Close Box
      if (action === 'close_box') {
        const { pcb, container, weight_kg } = req.body;
        // Logika update status atau simpan berat
        return res.status(200).json({ status: 'success', message: 'Box Closed' });
      }
    }

    return res.status(400).json({ error: 'Action not valid' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
