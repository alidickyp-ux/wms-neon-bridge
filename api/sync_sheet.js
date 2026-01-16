const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // PARSE BODY AMAN (WAJIB UNTUK GAS)
  let body = req.body;
  if (typeof body === "string") {
    body = JSON.parse(body);
  }

  const { data, is_last } = body || {};
  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: "No data" });
  }

  const client = await pool.connect();
  try {
    const sql = `
      INSERT INTO picklist_raw (
        picklist_number,
        tanggal_picking,
        customer,
        nama_customer,
        product_id,
        location_id,
        qty_pick,
        qty_real,
        sto_number,
        zona,
        level_val,
        row_val,
        subrow,
        rak_raw,
        lantai_level,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14,'open')
      ON CONFLICT (
        picklist_number,
        product_id,
        location_id,
        qty_pick
      ) DO NOTHING;
    `;

    for (const r of data) {
      await client.query(sql, [
        r.p_num,
        r.t_pick,
        r.cust,
        r.c_name,
        r.p_id,
        r.l_id,
        r.qty,
        r.sto,
        r.zona,
        r.lvl,
        r.row_v,
        r.sub,
        r.rak,
        r.lantai
      ]);
    }

    if (is_last) {
      pool
        .query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list")
        .catch(console.error);
    }

    res.status(200).json({
      status: "success",
      rows: data.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};
