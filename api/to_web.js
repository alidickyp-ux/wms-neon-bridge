const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
    // Handling CORS agar bisa diakses dari localhost VS Code
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { target } = req.query; // Menentukan tabel mana yang mau ditarik
    let client;

    try {
        client = await pool.connect();
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
                // Query sakti untuk menggabungkan data Picking & Packing
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

        const result = await client.query(queryText);
        return res.status(200).json({ status: 'success', data: result.rows });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (client) client.release();
    }
};
