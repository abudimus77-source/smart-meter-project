require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { fetchSmtData } = require('./smtService'); // Imported SMT Service

const app = express();
const port = process.env.PORT || 5000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// --- SECURITY MIDDLEWARE (The Lock) ---
const authenticateToken = (req, res, next) => {
  const token = req.header('x-auth-token');
  if (!token) return res.status(401).json({ message: "No token, authorization denied" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'mysecret');
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: "Token is not valid" });
  }
};

// --- DATABASE CONNECTION (Production Ready) ---
const isProduction = process.env.NODE_ENV === 'production' || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: isProduction ? process.env.DATABASE_URL : undefined,
  // Local fallbacks
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  // Render requires SSL for production databases
  ssl: isProduction ? { rejectUnauthorized: false } : false 
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client', err.stack);
  }
  console.log('Successfully connected to PostgreSQL!');
  release();
});

// --- DATABASE MIGRATION LOGIC ---
async function ensureUsersNameColumn() {
  try {
    const tableInfo = await pool.query("SELECT to_regclass('public.users') AS exists");
    if (!tableInfo.rows[0].exists) {
      console.log('users table missing; creating users table...');
      await pool.query(`CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      return;
    }
    const nameColumn = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema='public' AND table_name='users' AND column_name='name'
    `);
    if (nameColumn.rows.length === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN name TEXT');
    }
  } catch (err) {
    console.error('Error ensuring users.name column:', err.message);
  }
}
ensureUsersNameColumn();

// --- ROUTES ---

app.get('/', (req, res) => {
  res.send('Smart Meter API is running live on Render!');
});

// 1. AUTHENTICATION: REGISTER
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const newUser = await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
      [name, email, hashedPassword]
    );
    res.json(newUser.rows[0]);
  } catch (err) {
    res.status(500).send("Registration failed");
  }
});

// 2. AUTHENTICATION: LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (user.rows.length === 0) return res.status(400).json("Invalid Email");

    const validPassword = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!validPassword) return res.status(400).json("Invalid Password");

    const token = jwt.sign({ id: user.rows[0].id }, process.env.JWT_SECRET || 'mysecret', { expiresIn: '1h' });
    res.json({ token, user: { id: user.rows[0].id, name: user.rows[0].name } });
  } catch (err) {
    res.status(500).send("Login error");
  }
});

// 3. METERS: ADD NEW METER
app.post('/api/meters', authenticateToken, async (req, res) => {
  const { esiid, address, service_provider } = req.body;
  try {
    const newMeter = await pool.query(
      "INSERT INTO meters (user_id, esiid, address, service_provider) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.user.id, esiid, address, service_provider]
    );
    res.status(201).json(newMeter.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error while adding meter" });
  }
});

// 4. METERS: GET READINGS (LOCKED)
app.get('/api/meters/:id/readings', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const readings = await pool.query(
      "SELECT * FROM meter_readings WHERE meter_id = $1 ORDER BY read_time DESC",
      [id]
    );
    res.json(readings.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch readings" });
  }
});

// 5. METERS: SYNC WITH SMT (LOCKED)
app.post('/api/meters/:id/sync', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const meter = await pool.query("SELECT esiid FROM meters WHERE id = $1", [id]);
    if (meter.rows.length === 0) return res.status(404).json({ error: "Meter not found" });

    const syncDetails = await fetchSmtData(meter.rows[0].esiid);
    res.json({ message: "Synchronization successful!", data: syncDetails });
  } catch (err) {
    res.status(500).json({ error: "Sync failed" });
  }
});

// --- START SERVER ---
app.listen(port, () => {
  console.log(`Server is driving on port ${port}`);
});
