const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    let client;

    // --- LOGIKA GET: Ambil List (DARI MV) atau Detail ---
    if (req.method === 'GET') {
        try {
            client = await pool.connect();
            const { picklist_number } = req.query;

            if (picklist_number) {
                // Ambil detail barang - Diurutkan berdasarkan rute picking agar operator efisien
                const result = await client.query(
                    `SELECT product_id, location_id, qty_pick, nama_customer, status 
                     FROM picklist_raw 
                     WHERE picklist_number = $1 
                     ORDER BY zona ASC, row_val ASC, level_val ASC, subrow ASC, rak_raw ASC`,
                    [picklist_number]
                );
                return res.status(200).json({ status: 'success', data: result.rows });
            } else {
                // Ambil daftar dari MATERIALIZED VIEW (Sangat Cepat untuk Handheld)
                const result = await client.query("SELECT * FROM mv_picking_list");
                return res.status(200).json({ status: 'success', data: result.rows });
            }
        } catch (err) {
            return res.status(500).json({ status: 'error', message: err.message });
        } finally {
            if (client) client.release();
        }
    }

    // --- LOGIKA POST: Update dari Android & Sync GSheet ---
    if (req.method === 'POST') {
        try {
            const body = req.body;
            client = await pool.connect();

            // 1. UPDATE DARI ANDROID (Simpan Transaksi)
            if (body.action === 'update_qty') {
                const { picklist_number, product_id, location_id, qty_actual, picker_name } = body;

                await client.query('BEGIN');
                
                // Catat di tabel transaksi
                await client.query(
                    `INSERT INTO picking_transactions 
                    (picklist_number, product_id, location_id, qty_actual, picker_name, scanned_at) 
                    VALUES ($1, $2, $3, $4, $5, NOW())`, 
                    [picklist_number, product_id, location_id, qty_actual, picker_name]
                );

                // Update status di tabel raw agar menjadi 'fully picked'
                await client.query(
                    `UPDATE picklist_raw SET status = 'fully picked' 
                     WHERE picklist_number = $1 AND product_id = $2 AND location_id = $3`,
                    [picklist_number, product_id, location_id]
                );

                await client.query('COMMIT');

                /**
                 * OPTIMASI KECEPATAN:
                 * Menghapus 'await' agar Android tidak menunggu proses refresh yang berat (1-2 detik).
                 * Proses refresh tetap berjalan di server, tapi Android langsung dapat balasan sukses.
                 */
                pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list')
                    .catch(err => console.error("Background Refresh Error:", err));

                return res.status(200).json({ status: 'success', message: 'Transaksi Berhasil!' });
            } 
            
            // 2. UPLOAD DATA BARU DARI GSHEET
            else if (body.data && Array.isArray(body.data)) {
                const { data } = body;
                const query = `
                    INSERT INTO picklist_raw (
                        picklist_number, tanggal_picking, customer, nama_customer, 
                        product_id, location_id, qty_pick, qty_real, sto_number, 
                        zona, level_val, row_val, subrow, rak_raw, lantai_level, status
                    ) 
                    SELECT p_num, t_pick, cust, c_name, p_id, l_id, qty, qty_r, sto, zona, lvl, row_val, sub, rak, lantai, 'open' 
                    FROM UNNEST ($1::text[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[]) 
                    AS t(p_num, t_pick, cust, c_name, p_id, l_id, qty, qty_r, sto, zona, lvl, row_val, sub, rak, lantai)
                    ON CONFLICT (picklist_number, product_id, location_id, sto_number) 
                    DO UPDATE SET qty_pick = EXCLUDED.qty_pick, status = picklist_raw.status;
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

                // Refresh MV di background setelah sinkronisasi massal
                pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_picking_list')
                    .catch(err => console.error("Background Refresh Sync Error:", err));

                return res.status(200).json({ status: 'success', message: 'Sync GSheet Berhasil!' });
            }

        } catch (err) {
            if (client) await client.query('ROLLBACK');
            return res.status(500).json({ status: 'error', message: err.message });
        } finally {
            if (client) client.release();
        }
    }
};
