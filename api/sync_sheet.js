const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    
    const { data } = req.body;
    if (!data || !Array.isArray(data)) return res.status(400).json({ error: "Data format invalid" });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Query ini mengisi 16 kolom: 
        // 14 kolom dari GSheet ($1-$14) + qty_real (set 0) + status (set 'open')
        const query = `
            INSERT INTO picklist_raw (
                picklist_number, tanggal_picking, customer, nama_customer, 
                product_id, location_id, qty_pick, sto_number, zona, 
                level_val, row_val, subrow, rak_raw, lantai_level, 
                qty_real, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, 'open')
            ON CONFLICT (picklist_number, product_id, location_id, qty_pick) 
            DO NOTHING;
        `;

        for (const row of data) {
            await client.query(query, [
                row.p_num,    // $1
                row.t_pick,   // $2
                row.cust,     // $3
                row.c_name,   // $4
                row.p_id,     // $5
                row.l_id,     // $6
                row.qty,      // $7
                row.sto,      // $8
                row.zona,     // $9
                row.lvl,      // $10
                row.row_v,    // $11
                row.sub,      // $12
                row.rak,      // $13
                row.lantai    // $14
            ]);
        }

        await client.query('COMMIT');
        
        // Refresh MV agar Android sinkron
        pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list').catch(e => console.error(e));

        return res.status(200).json({ status: 'success', message: `${data.length} baris diproses.` });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("DB Error:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (client) client.release();
    }
};
