import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,               // penting untuk serverless
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 0,
});

export default async function handler(req, res) {
  // ===== CORS =====
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action;

  try {

    // =====================================================
    // 1️⃣ UPLOAD SNAPSHOT
    // =====================================================
    if (action === 'upload_snap' && req.method === 'POST') {

      if (!req.body || !Array.isArray(req.body.data)) {
        return res.status(400).json({ error: 'Invalid payload' });
      }

      const data = req.body.data;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');

        if (data.length > 0) {
          const values = [];
          const placeholders = [];

          data.forEach((item, i) => {
            const idx = i * 3;
            placeholders.push(`($${idx + 1}, $${idx + 2}, $${idx + 3})`);
            values.push(
              item.location_id,
              item.artikel,
              Number(item.qty_snap)
            );
          });

          await client.query(
            `INSERT INTO inventory_snap (location_id, artikel, qty_snap)
             VALUES ${placeholders.join(',')}`,
            values
          );
        }

        // refresh view (kalau ada)
        await client.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_matviews WHERE matviewname = 'inventory_reconciliation'
            ) THEN
              REFRESH MATERIALIZED VIEW inventory_reconciliation;
            END IF;
          END $$;
        `);

        await client.query('COMMIT');
        return res.status(200).json({ status: 'success', rows: data.length });

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // =====================================================
    // 2️⃣ ASSIGN LOCATION
    // =====================================================
    if (action === 'assign_location' && req.method === 'POST') {
      const { unique_id, status } = req.body || {};

      if (!unique_id) {
        return res.status(400).json({ error: 'unique_id required' });
      }

      await pool.query(
        'UPDATE master_lokasi SET assign = $1 WHERE unique_id = $2',
        [status, unique_id]
      );

      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_matviews WHERE matviewname = 'inventory_reconciliation'
          ) THEN
            REFRESH MATERIALIZED VIEW inventory_reconciliation;
          END IF;
        END $$;
      `);

      return res.status(200).json({ status: 'success' });
    }

    // =====================================================
    // 3️⃣ GET DATA
    // =====================================================
    if (action === 'get_data' && req.method === 'GET') {
      const target = req.query.target;

      const map = {
        recon: 'SELECT * FROM inventory_reconciliation',
        first: 'SELECT * FROM inventory_first ORDER BY timestamp DESC',
        second: 'SELECT * FROM inventory_second ORDER BY timestamp DESC',
        master: 'SELECT * FROM master_lokasi ORDER BY loc ASC',
      };

      if (!map[target]) {
        return res.status(400).json({ error: 'Invalid target' });
      }

      const result = await pool.query(map[target]);
      return res.status(200).json(result.rows);
    }

    return res.status(404).json({ error: 'Action not found' });

  } catch (err) {
    console.error('🔥 ERROR:', err);
    return res.status(500).json({
      error: err.message,
      hint: 'Cek payload JSON & pastikan materialized view ada'
    });
  }
}
