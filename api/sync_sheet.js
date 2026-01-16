const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
    // Headers CORS agar GSheet bisa akses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Gunakan POST' });

    const { data } = req.body; // Menerima data array dari GSheet
    if (!data || !Array.isArray(data)) return res.status(400).json({ message: 'Data tidak valid' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const query = `
            INSERT INTO picklist_raw (
                picklist_number, tanggal_picking, customer, nama_customer, 
                product_id, location_id, qty_pick, sto_number, zona, 
                level_val, row_val, subrow, rak_raw, lantai_level, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'open')
            ON CONFLICT (picklist_number, product_id, location_id) 
            DO NOTHING;
        `;

        for (const row of data) {
            await client.query(query, [
                row.p_num, row.t_pick, row.cust, row.c_name, 
                row.p_id, row.l_id, row.qty, row.sto, row.zona, 
                row.lvl, row.row_v, row.sub, row.rak, row.lantai
            ]);
        }

        await client.query('COMMIT');

        // Jalankan Refresh View di background agar response ke GSheet tetap cepat
        pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list').catch(e => console.error("Refresh View Error:", e));

        return res.status(200).json({ status: 'success', message: `${data.length} baris diproses` });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (client) client.release();
    }
};
