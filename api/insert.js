const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    let client;

    // --- LOGIKA GET: Ambil List (OPEN) atau Detail (Berdasarkan Picklist) ---
    if (req.method === 'GET') {
        try {
            client = await pool.connect();
            const { picklist_number } = req.query;

            if (picklist_number) {
                // Ambil detail barang untuk Android
                const result = await client.query(
                    "SELECT product_id, location_id, qty_pick, nama_customer, status FROM picklist_raw WHERE picklist_number = $1",
                    [picklist_number]
                );
                return res.status(200).json(result.rows);
            } else {
                // Ambil daftar nomor picklist yang masih memiliki item 'open' atau 'partial picked'
                const result = await client.query(
                    "SELECT DISTINCT picklist_number FROM picklist_raw WHERE status IN ('open', 'partial picked') ORDER BY picklist_number ASC"
                );
                const listNo = result.rows.map(row => row.picklist_number);
                return res.status(200).json(listNo);
            }
        } catch (err) {
            return res.status(500).json({ status: 'error', message: err.message });
        } finally {
            if (client) client.release();
        }
    }

    // --- LOGIKA POST: Sinkronisasi GSheet & Update Picking Android ---
    if (req.method === 'POST') {
        try {
            const body = req.body;
            client = await pool.connect();

            // 1. UPDATE DARI ANDROID (Simpan Transaksi Picking)
            if (body.action === 'update_qty') {
                const { picklist_number, product_id, location_id, sto_number, qty_actual, picker_name } = body;

                await client.query('BEGIN');
                
                // Masuk ke tabel transaksi (Log Detail)
                await client.query(
                    `INSERT INTO picking_transactions 
                    (picklist_number, product_id, location_id, sto_number, qty_actual, picker_name, scanned_at) 
                    VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                    [picklist_number, product_id, location_id, sto_number, qty_actual, picker_name]
                );

                // Note: Status di picklist_raw akan otomatis update via TRIGGER DATABASE (After Insert)
                
                await client.query('COMMIT');
                return res.status(200).json({ status: 'success', message: 'Transaksi Berhasil Dicatat!' });
            } 
            
            // 2. UPLOAD DATA BARU / SINKRONISASI DARI GSHEET (Bulk Upsert)
            else if (body.data && Array.isArray(body.data)) {
                const { data } = body;
                const query = `
                    INSERT INTO picklist_raw (
                        picklist_number, tanggal_picking, customer, nama_customer, 
                        product_id, location_id, qty_pick, qty_real, sto_number, 
                        zona, level_val, row_val, subrow, rak_raw, lantai_level, status
                    ) 
                    SELECT 
                        p_num, t_pick, cust, c_name, p_id, l_id, qty, qty_r, sto, 
                        zona, lvl, row_val, sub, rak, lantai, 'open' 
                    FROM UNNEST (
                        $1::text[], $2::date[], $3::text[], $4::text[], $5::text[], 
                        $6::text[], $7::int[], $8::int[], $9::text[], $10::text[], 
                        $11::text[], $12::text[], $13::text[], $14::text[], $15::text[]
                    ) AS t(p_num, t_pick, cust, c_name, p_id, l_id, qty, qty_r, sto, zona, lvl, row_val, sub, rak, lantai)
                    ON CONFLICT (picklist_number, product_id, location_id, sto_number) 
                    DO UPDATE SET 
                        qty_pick = EXCLUDED.qty_pick,
                        -- PROTEKSI STATUS: Jangan timpa status jika sudah diproses (Partial/Fully)
                        status = picklist_raw.status; 
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
                return res.status(200).json({ status: 'success', message: 'Sinkronisasi GSheet Berhasil!' });
            } else {
                return res.status(400).json({ status: 'error', message: 'Format data tidak dikenal' });
            }

        } catch (err) {
            if (client) await client.query('ROLLBACK');
            return res.status(500).json({ status: 'error', message: err.message });
        } finally {
            if (client) client.release();
        }
    }
};
