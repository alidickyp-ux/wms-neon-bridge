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

  const { type, data, is_last } = body || {}; // Tambahkan 'type' untuk bedakan tabel
  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: "No data" });
  }

  const client = await pool.connect();
  try {
    if (type === "header_autoneon") {
      // Logic Sinkronisasi Tabel autoneon
      for (const r of data) {
        const sqlHeader = `
          INSERT INTO autoneon (no_picking, no_sj, nama_toko, alamat, address)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (no_picking) 
          DO UPDATE SET 
            no_sj = EXCLUDED.no_sj,
            nama_toko = EXCLUDED.nama_toko,
            alamat = EXCLUDED.alamat,
            address = EXCLUDED.address,
            sync_at = CURRENT_TIMESTAMP;
        `;
        await client.query(sqlHeader, [r.p_num, r.no_sj, r.cust_name, r.addr1, r.addr2]);
      }
    } else {
      // Logic Sinkronisasi Tabel picklist_raw (Kode Lama Bos)
      const values = [];
      const placeholders = [];
      data.forEach((r, i) => {
        const b = i * 14;
        placeholders.push(
          `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},0,$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},'open')`
        );
        values.push(r.p_num, r.t_pick, r.cust, r.c_name, r.p_id, r.l_id, r.qty, r.sto, r.zona, r.lvl, r.row_v, r.sub, r.rak, r.lantai);
      });

      const sqlRaw = `
        INSERT INTO picklist_raw (picklist_number, tanggal_picking, customer, nama_customer, product_id, location_id, qty_pick, qty_real, sto_number, zona, level_val, row_val, subrow, rak_raw, lantai_level, status)
        VALUES ${placeholders.join(",")}
        ON CONFLICT (picklist_number, product_id, location_id)
        DO UPDATE SET qty_pick = EXCLUDED.qty_pick, tanggal_picking = EXCLUDED.tanggal_picking;
      `;
      await client.query(sqlRaw, values);
    }

    if (is_last) {
      await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list").catch(console.error);
    }

    res.status(200).json({ status: "success", type: type, rows: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};
