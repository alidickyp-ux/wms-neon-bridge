const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password } = req.body;
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT username, full_name FROM operators WHERE username = $1 AND password = $2',
      [username, password]
    );

    if (result.rows.length > 0) {
      return res.status(200).json({ status: 'success', user: result.rows[0] });
    } else {
      return res.status(401).json({ status: 'error', message: 'Username atau Password salah' });
    }
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    client.release();
  }
};
