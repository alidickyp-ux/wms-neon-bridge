const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    
    const { data, is_last } = req.body;
    if (!data || !Array.isArray(data)) return res.status(400).json({ error: "No data" });

    let client;
    try {
        client = await pool.connect();
        
        // Gunakan kueri tunggal yang lebih cepat daripada loop satu-satu di dalam transaksi jika memungkinkan, 
        // tapi untuk kestabilan kita tetap pakai loop sederhana dulu.
        const query = `
            INSERT INTO picklist_raw (
                picklist_number, tanggal_picking, customer, nama_customer, 
                product_id, location_id, qty_pick, qty_real, sto_number, 
                zona, level_val, row_val, subrow, rak_raw, lantai_level, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, 'open')
            ON CONFLICT (picklist_number, product_id, location_id, qty_pick) 
            DO NOTHING;
        `;

        for (const row of data) {
            await client.query(query, [
                row.p_num, row.t_pick, row.cust, row.c_name, 
                row.p_id, row.l_id, row.qty, row.sto, row.zona, 
                row.lvl, row.row_v, row.sub, row.rak, row.lantai
            ]);
        }

        if (is_last) {
            // Refresh MV secara async agar tidak menahan response
            pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list').catch(e => console.error(e));
        }

        return res.status(200).json({ status: 'success' });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
};
