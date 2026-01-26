import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

/* ======================================================
   DATABASE POOL (AMAN UNTUK VERCEL + NEON)
====================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/* ======================================================
   MAIN HANDLER
====================================================== */
export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action, target } = req.query;

  try {

    /* ======================================================
       1️⃣ LOGIN
    ====================================================== */
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          status: 'error',
          message: 'Username & password required'
        });
      }

      const result = await pool.query(
        `
        SELECT id, username, full_name, role
        FROM operators
        WHERE username = $1 AND password = $2
        `,
        [username, password]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          status: 'error',
          message: 'Username / password salah'
        });
      }

      return res.status(200).json({
        status: 'success',
        user: result.rows[0]
      });
    }

    /* ======================================================
       2️⃣ GET DATA
    ====================================================== */
    if (req.method === 'GET' && action === 'get_data') {

      let sql = '';

      /* ---------- MASTER LOKASI ---------- */
      if (target === 'master') {
        sql = `
          SELECT
            location_id,
            zone,
            aisle,
            unique_id,
            COALESCE(assign, 'closed') AS assign
          FROM master_lokasi
          ORDER BY zone, aisle, location_id
        `;
      }

      /* ---------- SNAPSHOT ---------- */
      else if (target === 'snapshot_list') {
        sql = `
          SELECT location_id, artikel, qty_snap
          FROM inventory_snap
          ORDER BY location_id
        `;
      }

      /* ---------- 1ST COUNT ---------- */
      else if (target === 'first') {
        sql = `
          SELECT *
          FROM inventory_first
          ORDER BY timestamp DESC
        `;
      }

      /* ---------- 2ND COUNT ---------- */
      else if (target === 'second') {
        sql = `
          SELECT *
          FROM inventory_second
          ORDER BY timestamp DESC
        `;
      }

      /* ---------- RECON ---------- */
      else if (target === 'recon') {
        sql = `
          SELECT *
          FROM inventory_reconciliation
          ORDER BY location_id
        `;
      }

      else {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid target'
        });
      }

      const result = await pool.query(sql);

      return res.status(200).json({
        status: 'success',
        data: result.rows || []
      });
    }

    /* ======================================================
       3️⃣ TOGGLE ASSIGN LOKASI (OPEN / CLOSED)
       Berdasarkan unique_id (boleh dobel)
    ====================================================== */
    if (req.method === 'POST' && action === 'assign_location') {
      const { unique_id, status } = req.body;

      if (!unique_id || !['open', 'closed'].includes(status)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid unique_id or status'
        });
      }

      const result = await pool.query(
        `
        UPDATE master_lokasi
        SET assign = $1
        WHERE unique_id = $2
        RETURNING unique_id, assign
        `,
        [status, unique_id]
      );

      return res.status(200).json({
        status: 'success',
        updated_rows: result.rows.length
      });
    }

    /* ======================================================
       4️⃣ SAVE INPUT (1ST & 2ND COUNT)
    ====================================================== */
    if (req.method === 'POST' && action === 'save_input') {
      const { location_id, artikel, qty, operator, target_table } = req.body;

      if (!location_id || !artikel || qty === undefined) {
        return res.status(400).json({
          status: 'error',
          message: 'Incomplete data'
        });
      }

      const isFirst = String(target_table).includes('1st');
      const table = isFirst ? 'inventory_first' : 'inventory_second';
      const colQty = isFirst ? 'qty_1st' : 'qty_2nd';

      const sql = `
        INSERT INTO ${table}
        (location_id, artikel, ${colQty}, operator, timestamp)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (location_id, artikel)
        DO UPDATE SET
          ${colQty} = EXCLUDED.${colQty},
          operator = EXCLUDED.operator,
          timestamp = NOW()
      `;

      await pool.query(sql, [
        String(location_id),
        String(artikel),
        parseInt(qty),
        operator || 'SYSTEM'
      ]);

      try {
        await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      } catch (_) {}

      return res.status(200).json({ status: 'success' });
    }

    /* ======================================================
       5️⃣ UPLOAD SNAPSHOT
    ====================================================== */
    if (req.method === 'POST' && action === 'upload_snap') {
      const { data } = req.body;

      if (!Array.isArray(data)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid snapshot data'
        });
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE inventory_snap');

        for (const item of data) {
          await client.query(
            `
            INSERT INTO inventory_snap (location_id, artikel, qty_snap)
            VALUES ($1, $2, $3)
            `,
            [
              String(item.location_id || ''),
              String(item.artikel || ''),
              parseInt(item.qty_snap) || 0
            ]
          );
        }

        try {
          await client.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
        } catch (_) {}

        await client.query('COMMIT');

        return res.status(200).json({ status: 'success' });

      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    /* ======================================================
       6️⃣ CLEAR DATA
    ====================================================== */
    if (req.method === 'POST' && ['clear_snap','clear_first','clear_second'].includes(action)) {
      const table =
        action === 'clear_snap' ? 'inventory_snap' :
        action === 'clear_first' ? 'inventory_first' :
        'inventory_second';

      await pool.query(`TRUNCATE TABLE ${table}`);

      try {
        await pool.query('REFRESH MATERIALIZED VIEW inventory_reconciliation');
      } catch (_) {}

      return res.status(200).json({ status: 'success' });
    }

    /* ======================================================
       FALLBACK
    ====================================================== */
    return res.status(400).json({
      status: 'error',
      message: 'Invalid action'
    });

  } catch (error) {
    console.error('API_ERROR:', error.message);

    // ❗️ANTI CRASH RESPONSE
    return res.status(200).json({
      status: 'error',
      message: 'Database error (handled)',
      detail: error.message
    });
  }
}
