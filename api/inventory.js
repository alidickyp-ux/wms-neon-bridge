import { Pool } from '@neondatabase/serverless';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default async function handler(req, res) {
  const { action } = req.query;

  try {
    // 1. ACTION: UPLOAD SNAPSHOT
    if (action === 'upload_snap' && req.method === 'POST') {
      const { data } = req.body; // Data dari Excel [{location_id, artikel, qty_snap}]
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');
        
        for (const item of data) {
          await client.query(
            'INSERT INTO inventory_snap (location_id, artikel, qty_snap) VALUES ($1, $2, $3)',
            [item.location_id, item.artikel, item.qty_snap]
          );
        }
        
        await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        await client.query('COMMIT');
        return res.status(200).json({ status: 'success', message: 'Snapshot Updated' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    }

    // 2. ACTION: ASSIGN/TOGGLE STATUS LOKASI (PEMANTIK)
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body; // status: 'open' / 'closed'
      
      await pool.query('UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2', [status, unique_id]);
      await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      
      return res.status(200).json({ status: 'success', new_status: status });
    }

    // 3. ACTION: GET HISTORY & RECONCILIATION
    if (action === 'get_data' && req.method === 'GET') {
      const { target } = req.query;
      let queryText = '';

      if (target === 'recon') queryText = 'SELECT * FROM inventory_reconciliation';
      else if (target === 'first') queryText = 'SELECT * FROM inventory_first ORDER BY timestamp DESC';
      else if (target === 'second') queryText = 'SELECT * FROM inventory_second ORDER BY timestamp DESC';
      else if (target === 'master') queryText = 'SELECT * FROM master_lokasi ORDER BY loc ASC';

      const result = await pool.query(queryText);
      return res.status(200).json({ status: 'success', data: result.rows });
    }

    return res.status(400).json({ error: 'Action not found' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
