const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  // Android kirim ?pcb=PCB123&container=BOX-001
  const { pcb, container } = req.query;

  if (!pcb || !container) {
    return res.status(400).json({ error: "PCB and Container Number are required" });
  }

  let client;
  try {
    client = await pool.connect();

    // Query untuk mengambil list barang di dalam laci tersebut
    // Kita joinkan dengan master produk jika Anda ingin memunculkan Nama Barang (opsional)
    const query = `
      SELECT 
        huid,
        product_id, 
        qty_packed,
        packer_name,
        created_at
      FROM packing_transactions 
      WHERE picklist_number = $1 
      AND container_number = $2
      AND status = 'open'
      ORDER BY created_at DESC
    `;

    const result = await client.query(query, [pcb, container]);

    // Menghitung total qty dalam satu laci untuk ditampilkan di bawah (Total PCS)
    const totalPcs = result.rows.reduce((sum, item) => sum + Number(item.qty_packed), 0);

    return res.status(200).json({
      status: 'success',
      container_info: {
        container_number: container,
        picklist_number: pcb,
        total_items: result.rows.length,
        total_pcs: totalPcs
      },
      packing_list: result.rows
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
