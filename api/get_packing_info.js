const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  const { pcb } = req.query; // Android mengirim ?pcb=PCB23...

  if (!pcb) return res.status(400).json({ error: "PCB Number is required" });

  let client;
  try {
    client = await pool.connect();

    // Query untuk mengambil info akumulasi
    const query = `
      SELECT 
        p.picklist_number,
        p.nama_customer,
        SUM(p.qty_pick) as total_qty_req,
        SUM(p.qty_actual) as total_pick,
        (SELECT COALESCE(SUM(qty_packed), 0) 
         FROM packing_transactions 
         WHERE picklist_number = p.picklist_number) as total_pack
      FROM picklist_raw p
      WHERE p.picklist_number = $1
      GROUP BY p.picklist_number, p.nama_customer
    `;

    const result = await client.query(query, [pcb]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "PCB not found" });
    }

    return res.status(200).json({
      status: 'success',
      data: result.rows[0]
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
