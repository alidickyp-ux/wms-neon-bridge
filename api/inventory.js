import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {

    // ===============================
    // GET MASTER LOKASI (ONLY TOGGLE)
    // ===============================
    if (req.method === 'GET' && action === 'get_master') {
      const sql = `
        SELECT 
          unique_id,
          COALESCE(assign, 'closed') AS assign
        FROM master_lokasi
        ORDER BY unique_id ASC
      `;

      const result = await pool.query(sql);
      return res.status(200).json({
        status: 'success',
        data: result.rows
      });
    }

    // ===============================
    // TOGGLE ASSIGN (OPEN / CLOSED)
    // ===============================
    if (req.method === 'POST' && action === 'toggle_master') {
      const { unique_id, assign } = req.body;

      if (!unique_id || !assign)
        throw new Error("Payload tidak lengkap");

      await pool.query(
        `UPDATE master_lokasi
         SET assign = $1
         WHERE unique_id = $2`,
        [assign, unique_id]
      );

      return res.status(200).json({
        status: 'success',
        unique_id,
        assign
      });
    }

    return res.status(404).json({ error: 'Action not found' });

  } catch (err) {
    console.error("BACKEND ERROR:", err.message);
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
}
