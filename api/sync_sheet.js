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

  let body = req.body;
  if (typeof body === "string") body = JSON.parse(body);

  const { data, is_last } = body || {};
  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: "No data" });
  }

  if (data.length > 50) {
    return res.status(400).json({ error: "Batch terlalu besar" });
  }

  const client = await pool.connect();
  try {
    const values = [];
    const placeholders = [];

    data.forEach((r, i) => {
      const b = i * 14;
      placeholders.push(
        `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},
          $${b+7},0,$${b+8},$${b+9},$${b+10},$${b+11},
          $${b+12},$${b+13},$${b+14},'open')`
      );

      values.push(
        r.p_num, r.t_pick, r.cust, r.c_name,
        r.p_id, r.l_id, r.qty,
        r.sto, r.zona, r.lvl,
        r.row_v, r.sub, r.rak, r.lantai
      );
    });

    const sql = `
      INSERT INTO picklist_raw (
        picklist_number, tanggal_picking, customer, nama_customer,
        product_id, location_id, qty_pick, qty_real, sto_number,
        zona, level_val, row_val, subrow, rak_raw, lantai_level, status
      )
      VALUES ${placeholders.join(",")}
      ON CONFLICT (picklist_number, product_id, location_id)
      DO UPDATE SET
        qty_pick = EXCLUDED.qty_pick,
        tanggal_picking = EXCLUDED.tanggal_picking;
    `;

    await client.query(sql, values);

    if (is_last) {
      pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list")
        .catch(console.error);
    }

    res.status(200).json({ status: "success", rows: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};
