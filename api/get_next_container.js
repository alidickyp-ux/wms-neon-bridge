const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  const { pcb, type } = req.query; // Android kirim ?pcb=PCB123&type=BOX atau ?pcb=PCB123&type=KARUNG

  if (!pcb || !type) {
    return res.status(400).json({ error: "PCB and Type (BOX/KARUNG) are required" });
  }

  let client;
  try {
    client = await pool.connect();

    // Query untuk mencari angka tertinggi di container_number untuk PCB ini
    // Kita mengambil angka di dalam string menggunakan regex (misal BOX-001 diambil 1)
    const query = `
      SELECT MAX(CAST(SUBSTRING(container_number FROM '[0-9]+') AS INTEGER)) as last_num 
      FROM packing_transactions 
      WHERE picklist_number = $1
    `;

    const result = await client.query(query, [pcb]);
    const lastNum = result.rows[0].last_num || 0;
    const nextNum = lastNum + 1;

    // Format menjadi 3 digit (001, 002, dst) dan gabungkan dengan Type (BOX/KARUNG)
    const formattedNum = `${type.toUpperCase()}-${nextNum.toString().padStart(3, '0')}`;

    return res.status(200).json({
      status: 'success',
      next_container_number: formattedNum
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
};
