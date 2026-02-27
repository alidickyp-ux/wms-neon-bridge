import { Pool } from 'pg';

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, cache-control');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, target } = req.query;

  try {

    // ================= 1. GET DATA =================
    if (action === 'get_data' && req.method === 'GET') {

      // ── LIST 3PL / TRANSPORTER ──────────────────────────────────────
      if (target === '3pl_list') {
        const { rows } = await pool.query(
          `SELECT transporter_id, tracking_prefix, tracking_length_min, 
                  tracking_length_max, use_do_reference, notes
           FROM "3pl_id"
           WHERE is_active = TRUE
           ORDER BY transporter_id ASC`
        );
        return res.json({ status: 'success', data: rows });
      }

      // ── HISTORY DISPATCH ───────────────────────────────────────────
      if (target === 'dispatch_list') {
        const { rows } = await pool.query(
          `SELECT id, transporter_id, do_reference, tracking_reference, 
                  operator, scanned_at
           FROM dispatch_log
           ORDER BY scanned_at DESC
           LIMIT 500`
        );
        return res.json({ status: 'success', data: rows });
      }

      return res.json({ status: 'error', data: [], message: `Target '${target}' tidak ditemukan` });
    }

    // ================= 2. SAVE DISPATCH SCAN =================
    if (action === 'save_dispatch' && req.method === 'POST') {
      const { transporter_id, do_reference, tracking_reference, operator } = req.body;

      if (!transporter_id || !operator) {
        return res.status(400).json({ status: 'error', message: 'transporter_id dan operator wajib diisi' });
      }

      // Minimal salah satu harus ada
      if (!do_reference && !tracking_reference) {
        return res.status(400).json({ status: 'error', message: 'DO Reference atau Tracking Reference wajib diisi' });
      }

      // Cek duplikat — tracking/DO yang sama di transporter yang sama
      const refToCheck = tracking_reference || do_reference;
      const colToCheck = tracking_reference ? 'tracking_reference' : 'do_reference';

      const { rows: existing } = await pool.query(
        `SELECT id FROM dispatch_log 
         WHERE transporter_id = $1 AND ${colToCheck} = $2`,
        [transporter_id, refToCheck]
      );

      if (existing.length > 0) {
        return res.json({ status: 'duplicate', message: `Referensi '${refToCheck}' sudah pernah discan untuk ${transporter_id}` });
      }

      // Save
      await pool.query(
        `INSERT INTO dispatch_log (transporter_id, do_reference, tracking_reference, operator, scanned_at)
         VALUES ($1, $2, $3, $4, NOW() AT TIME ZONE 'Asia/Jakarta')`,
        [transporter_id, do_reference || null, tracking_reference || null, operator]
      );

      return res.json({ status: 'success', message: 'Data tersimpan' });
    }

    // ================= 3. VALIDATE TRACKING =================
    // Cek apakah tracking reference sesuai dengan transporter yang dipilih
    if (action === 'validate_tracking' && req.method === 'GET') {
      const { transporter_id, reference } = req.query;

      if (!transporter_id || !reference) {
        return res.status(400).json({ status: 'error', message: 'transporter_id dan reference wajib diisi' });
      }

      // Ambil aturan validasi dari 3pl_id
      const { rows } = await pool.query(
        `SELECT * FROM "3pl_id" WHERE transporter_id = $1 AND is_active = TRUE`,
        [transporter_id]
      );

      if (rows.length === 0) {
        return res.json({ status: 'error', valid: false, message: `Transporter '${transporter_id}' tidak ditemukan` });
      }

      const rule = rows[0];

      // Kalau pakai DO reference — skip validasi format
      if (rule.use_do_reference) {
        return res.json({ status: 'success', valid: true, use_do: true, message: 'Gunakan DO Reference' });
      }

      // Validasi prefix
      if (rule.tracking_prefix) {
        const prefixes = rule.tracking_prefix.split(',').map(p => p.trim());
        const matchPrefix = prefixes.some(p => reference.toUpperCase().startsWith(p.toUpperCase()));
        if (!matchPrefix) {
          return res.json({
            status: 'error',
            valid: false,
            message: `Format tidak valid untuk ${transporter_id}. Prefix yang diharapkan: ${rule.tracking_prefix}`
          });
        }
      }

      // Validasi panjang
      if (rule.tracking_length_min && reference.length < rule.tracking_length_min) {
        return res.json({
          status: 'error',
          valid: false,
          message: `Tracking terlalu pendek. Min ${rule.tracking_length_min} karakter`
        });
      }
      if (rule.tracking_length_max && reference.length > rule.tracking_length_max) {
        return res.json({
          status: 'error',
          valid: false,
          message: `Tracking terlalu panjang. Max ${rule.tracking_length_max} karakter`
        });
      }

      return res.json({ status: 'success', valid: true, message: 'Tracking valid' });
    }

    // ================= 4. CLEAR DATA =================
    if (action === 'clear_dispatch' && req.method === 'POST') {
      await pool.query(`TRUNCATE TABLE dispatch_log`);
      return res.json({ status: 'success' });
    }

    // ================= 5. DELETE SINGLE RECORD =================
    if (action === 'delete_dispatch' && req.method === 'POST') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ status: 'error', message: 'id wajib diisi' });
      await pool.query(`DELETE FROM dispatch_log WHERE id = $1`, [id]);
      return res.json({ status: 'success' });
    }

    return res.status(404).json({ error: 'ACTION NOT FOUND' });

  } catch (err) {
    console.error('DISPATCH API ERROR', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
