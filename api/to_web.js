const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
    // Handling CORS agar bisa diakses dari localhost VS Code
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // Ambil target, action, dan pcb dari query string
    const { target, action, pcb } = req.query; 
    let client;

    try {
        client = await pool.connect();

        // --- LOGIKA 1: Jika Action adalah get_print_data (Khusus Cetak Label) ---
        if (action === 'get_print_data') {
            if (!pcb) {
                return res.status(400).json({ status: 'error', message: 'Parameter PCB diperlukan' });
            }

            const result = await client.query(`
                SELECT pt.container_number, pt.huid, pt.container_type, pt.picklist_number,
                       MAX(pt.scanned_at) as tanggal_packing, 
                       COALESCE(an.no_sj, '-') AS no_sj,
                       COALESCE(an.nama_toko, (SELECT nama_customer FROM picklist_raw WHERE picklist_number = pt.picklist_number LIMIT 1)) AS nama_toko,
                       COALESCE(an.alamat, '-') AS alamat_toko,
                       COALESCE(an.address, '-') AS address_toko,
                       COALESCE(pt.weight_kg, 0)::float AS weight_kg,
                       SUM(pt.qty_packed)::int AS total_pcs_box,
                       MAX(pt.scanned_by) AS packer_name,
                       (SELECT json_agg(items) FROM (
                            SELECT sub.product_id AS sku, MAX(COALESCE(mp.description, sub.product_id)) AS nama_item, SUM(sub.qty_packed)::int AS qty
                            FROM packing_transactions sub
                            LEFT JOIN master_product mp ON sub.product_id = mp.product_id
                            WHERE sub.picklist_number = pt.picklist_number AND sub.container_number = pt.container_number
                            GROUP BY sub.product_id
                       ) items) AS item_details
                FROM packing_transactions pt
                LEFT JOIN autoneon an ON pt.picklist_number = an.no_picking
                WHERE pt.picklist_number = $1
                GROUP BY pt.picklist_number, pt.container_number, pt.huid, pt.container_type, pt.weight_kg, an.no_sj, an.nama_toko, an.alamat, an.address
                ORDER BY pt.container_number
            `, [pcb]);

            return res.status(200).json({ status: 'success', data: result.rows });
        }

        // --- LOGIKA 2: Jika Action default (get_data untuk Dashboard/Tabel) ---
        let queryText = "";
        switch (target) {
            case 'picking_compliance':
                queryText = "SELECT * FROM picking_compliance ORDER BY created_at DESC LIMIT 200";
                break;
            
            case 'picking_transactions':
                queryText = "SELECT * FROM picking_transactions ORDER BY scanned_at DESC LIMIT 200";
                break;

            case 'packing_transactions':
                queryText = "SELECT * FROM packing_transactions ORDER BY scanned_at DESC LIMIT 200";
                break;

            case 'outbound_explorer':
                queryText = `
                    SELECT 
                        pr.picklist_number, 
                        pr.product_id as sku, 
                        mp.description, 
                        pr.qty_pick as qty_req, 
                        pr.qty_actual as qty_picked,
                        COALESCE(pack.total_packed, 0) as qty_packed,
                        pr.status
                    FROM picklist_raw pr
                    LEFT JOIN master_product mp ON pr.product_id = mp.product_id
                    LEFT JOIN (
                        SELECT picklist_number, product_id, SUM(qty_packed) as total_packed 
                        FROM packing_transactions 
                        GROUP BY picklist_number, product_id
                    ) pack ON pr.picklist_number = pack.picklist_number AND pr.product_id = pack.product_id
                    ORDER BY pr.picklist_number DESC
                `;
                break;

            default:
                return res.status(400).json({ status: 'error', message: 'Target menu tidak valid' });
        }

        const resultData = await client.query(queryText);
        return res.status(200).json({ status: 'success', data: resultData.rows });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (client) client.release();
    }
};
