const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  // Setup CORS agar Android bisa akses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;

  // --- LOGIKA GET (UNTUK ANDROID: AMBIL LIST PICKLIST) ---
  if (req.method === 'GET') {
    try {
      client = await pool.connect();
      const result = await client.query(
        "SELECT DISTINCT picklist_no FROM picklist_final WHERE status = 'open' ORDER BY picklist_no ASC"
      );
      // Kirim array string: ["PL001", "PL002"]
      const listNo = result.rows.map(row => row.picklist_no);
      return res.status(200).json(listNo);
    } catch (err) {
      return res.status(500).json({ status: 'error', message: err.message });
    } finally {
      if (client) client.release();
    }
  }

  // --- LOGIKA POST (UNTUK UPLOAD DATA RAW SEPERTI KEMARIN) ---
  if (req.method === 'POST') {
    try {
      const { data } = req.body;
      client = await pool.connect();

      const query = `
        INSERT INTO picklist_raw (
          picklist_number, tanggal_picking, customer, nama_customer, 
          product_id, location_id, qty_pick, qty_real, sto_number, 
          zona, level_val, row_val, subrow, rak_raw, lantai_level
        ) 
        SELECT * FROM UNNEST (
          $1::text[], $2::date[], $3::text[], $4::text[], $5::text[], 
          $6::text[], $7::int[], $8::int[], $9::text[], $10::text[], 
          $11::text[], $12::text[], $13::text[], $14::text[], $15::text[]
        )
        ON CONFLICT (picklist_number, product_id, location_id, sto_number) 
        DO UPDATE SET qty_pick = EXCLUDED.qty_pick;
      `;

      const cols = Array.from({ length: 15 }, () => []);
      data.forEach(d => {
        cols[0].push(d.p_num); cols[1].push(d.t_pick); cols[2].push(d.cust);
        cols[3].push(d.c_name); cols[4].push(d.p_id); cols[5].push(d.l_id);
        cols[6].push(d.qty); cols[7].push(d.qty_r || 0); cols[8].push(d.sto);
        cols[9].push(d.zona); cols[10].push(d.lvl); cols[11].push(d.row);
        cols[12].push(d.sub); cols[13].push(d.rak); cols[14].push(d.lantai);
      });

      await client.query(query, cols);
      return res.status(200).json({ status: 'success', message: 'Data Raw Berhasil Masuk!' });
    } catch (err) {
      return res.status(500).json({ status: 'error', message: err.message });
    } finally {
      if (client) client.release();
    }
  }
};
