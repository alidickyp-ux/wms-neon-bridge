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

      if (target === '3pl_list') {
        const { rows } = await pool.query(
          `SELECT transporter_id, tracking_prefix, tracking_length_min,
                  tracking_length_max, use_do_reference, notes
           FROM "3pl_id" WHERE is_active = TRUE ORDER BY transporter_id ASC`
        );
        return res.json({ status: 'success', data: rows });
      }

      if (target === 'session_list') {
        const statusFilter = req.query.status || null;
        let sql = `
          SELECT s.*,
                 COUNT(d.id) FILTER (WHERE d.handover_status = 'CONFIRMED')   AS confirmed_count,
                 COUNT(d.id) FILTER (WHERE d.handover_status = 'PENDING')     AS pending_count,
                 COUNT(d.id) FILTER (WHERE d.handover_status = 'DISCREPANCY') AS discrepancy_count
          FROM dispatch_session s
          LEFT JOIN dispatch_log d ON d.session_code = s.session_code
        `;
        const params = [];
        if (statusFilter) { sql += ` WHERE s.status = $1`; params.push(statusFilter); }
        sql += ` GROUP BY s.id ORDER BY s.created_at DESC`;
        const { rows } = await pool.query(sql, params);
        return res.json({ status: 'success', data: rows });
      }

      if (target === 'session_log') {
        const { session_code } = req.query;
        if (!session_code) return res.json({ status: 'error', data: [] });
        const { rows } = await pool.query(
          `SELECT * FROM dispatch_log WHERE session_code = $1 ORDER BY scanned_at DESC`,
          [session_code]
        );
        return res.json({ status: 'success', data: rows });
      }

      if (target === 'dispatch_list') {
        const { rows } = await pool.query(`SELECT * FROM dispatch_log ORDER BY scanned_at DESC LIMIT 500`);
        return res.json({ status: 'success', data: rows });
      }

      return res.json({ status: 'error', data: [], message: `Target '${target}' tidak ditemukan` });
    }

    // ================= 2. CREATE SESSION =================
    if (action === 'create_session' && req.method === 'POST') {
      const { transporter_id, operator } = req.body;
      if (!transporter_id || !operator)
        return res.status(400).json({ status: 'error', message: 'transporter_id dan operator wajib diisi' });

      const today   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
      const prefix  = transporter_id.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5);

      const { rows: existing } = await pool.query(
        `SELECT COUNT(*) as cnt FROM dispatch_session
         WHERE transporter_id = $1 AND created_at::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`,
        [transporter_id]
      );
      const seq         = String(parseInt(existing[0].cnt) + 1).padStart(3, '0');
      const sessionCode = `${prefix}-${dateStr}-${seq}`;

      await pool.query(
        `INSERT INTO dispatch_session (session_code, transporter_id, operator, status, created_at)
         VALUES ($1, $2, $3, 'OPEN', NOW() AT TIME ZONE 'Asia/Jakarta')`,
        [sessionCode, transporter_id, operator]
      );

      return res.json({ status: 'success', session_code: sessionCode });
    }

    // ================= 3. SAVE SCAN SORTING =================
    if (action === 'save_dispatch' && req.method === 'POST') {
      const { transporter_id, do_reference, tracking_reference, operator, session_code } = req.body;

      if (!transporter_id || !operator || !session_code)
        return res.status(400).json({ status: 'error', message: 'transporter_id, operator, session_code wajib diisi' });
      if (!do_reference && !tracking_reference)
        return res.status(400).json({ status: 'error', message: 'DO Reference atau Tracking Reference wajib diisi' });

      // Cek session masih OPEN
      const { rows: sessionRows } = await pool.query(
        `SELECT status FROM dispatch_session WHERE session_code = $1`, [session_code]
      );
      if (sessionRows.length === 0)
        return res.json({ status: 'error', message: 'Session tidak ditemukan' });
      if (sessionRows[0].status !== 'OPEN')
        return res.json({ status: 'error', message: 'Session sudah CLOSED, tidak bisa scan lagi' });

      // Cek duplikat di SEMUA session (global) — mencegah scan label yang sama dua kali
      const refToCheck = tracking_reference || do_reference;
      const colToCheck = tracking_reference ? 'tracking_reference' : 'do_reference';
      const { rows: dup } = await pool.query(
        `SELECT d.id, d.session_code FROM dispatch_log d WHERE d.${colToCheck} = $1`,
        [refToCheck]
      );
      if (dup.length > 0)
        return res.json({
          status: 'duplicate',
          message: `'${refToCheck}' sudah pernah discan di session ${dup[0].session_code}`
        });

      await pool.query(
        `INSERT INTO dispatch_log
           (transporter_id, do_reference, tracking_reference, operator, session_code, handover_status, scanned_at)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW() AT TIME ZONE 'Asia/Jakarta')`,
        [transporter_id, do_reference || null, tracking_reference || null, operator, session_code]
      );

      await pool.query(
        `UPDATE dispatch_session SET total_sorted = total_sorted + 1 WHERE session_code = $1`,
        [session_code]
      );

      return res.json({ status: 'success', message: 'Tersimpan' });
    }

    // ================= 4. CLOSE SESSION =================
    if (action === 'close_session' && req.method === 'POST') {
      const { session_code } = req.body;
      if (!session_code)
        return res.status(400).json({ status: 'error', message: 'session_code wajib diisi' });

      const { rows } = await pool.query(
        `SELECT total_sorted, status FROM dispatch_session WHERE session_code = $1`, [session_code]
      );
      if (rows.length === 0)
        return res.json({ status: 'error', message: 'Session tidak ditemukan' });
      if (rows[0].status !== 'OPEN')
        return res.json({ status: 'error', message: 'Session sudah CLOSED' });
      if (rows[0].total_sorted === 0)
        return res.json({ status: 'error', message: 'Tidak bisa close session kosong (0 scan)' });

      await pool.query(
        `UPDATE dispatch_session SET status = 'CLOSED', closed_at = NOW() AT TIME ZONE 'Asia/Jakarta'
         WHERE session_code = $1`,
        [session_code]
      );

      return res.json({ status: 'success', message: `Session ${session_code} berhasil di-CLOSE` });
    }

    // ================= 5. VALIDATE TRACKING =================
    if (action === 'validate_tracking' && req.method === 'GET') {
      const { transporter_id, reference } = req.query;
      if (!transporter_id || !reference)
        return res.status(400).json({ status: 'error', message: 'transporter_id dan reference wajib diisi' });

      const { rows } = await pool.query(
        `SELECT * FROM "3pl_id" WHERE transporter_id = $1 AND is_active = TRUE`, [transporter_id]
      );
      if (rows.length === 0)
        return res.json({ status: 'error', valid: false, message: `Transporter '${transporter_id}' tidak ditemukan` });

      const rule = rows[0];
      if (rule.use_do_reference)
        return res.json({ status: 'success', valid: true, use_do: true, message: 'Gunakan DO Reference' });

      if (rule.tracking_prefix) {
        const prefixes    = rule.tracking_prefix.split(',').map(p => p.trim());
        const matchPrefix = prefixes.some(p => reference.toUpperCase().startsWith(p.toUpperCase()));
        if (!matchPrefix)
          return res.json({ status: 'error', valid: false,
            message: `Format tidak valid untuk ${transporter_id}. Prefix: ${rule.tracking_prefix}` });
      }
      if (rule.tracking_length_min && reference.length < rule.tracking_length_min)
        return res.json({ status: 'error', valid: false,
          message: `Tracking terlalu pendek. Min ${rule.tracking_length_min} karakter` });
      if (rule.tracking_length_max && reference.length > rule.tracking_length_max)
        return res.json({ status: 'error', valid: false,
          message: `Tracking terlalu panjang. Max ${rule.tracking_length_max} karakter` });

      return res.json({ status: 'success', valid: true, message: 'Tracking valid' });
    }

    // ================= 6. HANDOVER — SAVE SCAN =================
    if (action === 'save_handover' && req.method === 'POST') {
      const { session_code, tracking_reference, do_reference, security_name, status, notes } = req.body;
      // status: CONFIRMED | NOT_FOUND | CANCELLED

      if (!session_code || !security_name)
        return res.status(400).json({ status: 'error', message: 'session_code dan security_name wajib diisi' });

      const ref = tracking_reference || do_reference;
      const col = tracking_reference ? 'tracking_reference' : 'do_reference';

      await pool.query(
        `UPDATE dispatch_log SET handover_status = $1 WHERE session_code = $2 AND ${col} = $3`,
        [status, session_code, ref]
      );

      await pool.query(
        `INSERT INTO dispatch_handover
           (session_code, tracking_reference, do_reference, status, security_name, notes, handover_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() AT TIME ZONE 'Asia/Jakarta')`,
        [session_code, tracking_reference || null, do_reference || null, status, security_name, notes || null]
      );

      return res.json({ status: 'success', message: `Status: ${status}` });
    }

    // ================= 7. COMPLETE HANDOVER =================
    if (action === 'complete_handover' && req.method === 'POST') {
      const { session_code } = req.body;

      // Yang masih PENDING otomatis jadi DISCREPANCY
      await pool.query(
        `UPDATE dispatch_log SET handover_status = 'DISCREPANCY'
         WHERE session_code = $1 AND handover_status = 'PENDING'`,
        [session_code]
      );

      await pool.query(
        `UPDATE dispatch_session SET status = 'HANDOVER_DONE' WHERE session_code = $1`,
        [session_code]
      );

      const { rows: summary } = await pool.query(
        `SELECT handover_status, COUNT(*) as count
         FROM dispatch_log WHERE session_code = $1 GROUP BY handover_status`,
        [session_code]
      );

      return res.json({ status: 'success', summary });
    }

    // ================= 8. DELETE SINGLE SCAN =================
    if (action === 'delete_dispatch' && req.method === 'POST') {
      const { id, session_code } = req.body;
      if (!id) return res.status(400).json({ status: 'error', message: 'id wajib diisi' });

      await pool.query(`DELETE FROM dispatch_log WHERE id = $1`, [id]);
      if (session_code) {
        await pool.query(
          `UPDATE dispatch_session SET total_sorted = total_sorted - 1 WHERE session_code = $1`,
          [session_code]
        );
      }
      return res.json({ status: 'success' });
    }

    return res.status(404).json({ error: 'ACTION NOT FOUND' });

  } catch (err) {
    console.error('DISPATCH API ERROR', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
