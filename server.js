require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 5000;
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

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection Setup
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Test Database Connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client', err.stack);
  }
  console.log('Successfully connected to PostgreSQL!');
  release();
});

// Ensure users.name exists to support registration flow
async function ensureUsersNameColumn() {
  try {
    const tableInfo = await pool.query("SELECT to_regclass('public.users') AS exists");
    if (!tableInfo.rows[0].exists) {
      console.log('users table missing; creating users table with name/email/password_hash');
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
      console.log('users table exists, adding missing name column');
      await pool.query('ALTER TABLE users ADD COLUMN name TEXT');

      // If a username exists, copy it to name for compatibility
      const usernameColumn = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users' AND column_name='username'
      `);
      if (usernameColumn.rows.length > 0) {
        await pool.query('UPDATE users SET name = username WHERE name IS NULL');
      }
    }
  } catch (err) {
    console.error('Error ensuring users.name column:', err.message);
    throw err;
  }
}

ensureUsersNameColumn().catch((err) => {
  console.error('Migration error, server may not function correctly:', err.message);
});

// --- ROUTES (Define these BEFORE app.listen) ---

app.get('/', (req, res) => {
  res.send('Smart Meter API is running...');
});

// ADD A NEW METER
app.post('/api/meters', async (req, res) => {
  console.log("Incoming Data:", req.body); // Useful for debugging
  const { user_id, esiid, address, service_provider } = req.body;

  try {
    const newMeter = await pool.query(
      "INSERT INTO meters (user_id, esiid, address, service_provider) VALUES ($1, $2, $3, $4) RETURNING *",
      [user_id, esiid, address, service_provider]
    );

    res.status(201).json({
      message: "Meter added successfully!",
      meter: newMeter.rows[0]
    });
  } catch (err) {
    console.error("DB Error:", err.message);
    res.status(500).json({ error: "Server error while adding meter" });
  }
});

// GET READINGS
// Add 'authenticateToken' here to lock the route
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

// --- USER REGISTRATION ---
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    // 1. Scramble the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 2. Insert into the users table
    const newUser = await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
      [name, email, hashedPassword]
    );

    res.json(newUser.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Registration failed");
  }
});

// --- USER LOGIN ---
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

    if (user.rows.length === 0) return res.status(400).json("Invalid Email");

    // Check password
    const validPassword = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!validPassword) return res.status(400).json("Invalid Password");

    // Create a Token (the digital key)
    const token = jwt.sign({ id: user.rows[0].id }, process.env.JWT_SECRET || 'mysecret', { expiresIn: '1h' });
    
    res.json({ token, user: { id: user.rows[0].id, name: user.rows[0].name } });
  } catch (err) {
    res.status(500).send("Login error");
  }
});

// --- START SERVER ---
app.listen(port, () => {
  console.log(`Server is driving on port ${port}`);
});
const { fetchSmtData } = require('./smtService');

// This route is also PROTECTED by the lock (authenticateToken)
app.post('/api/meters/:id/sync', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        // 1. Get the meter's ESIID from the database
        const meter = await pool.query("SELECT esiid FROM meters WHERE id = $1", [id]);
        
        if (meter.rows.length === 0) {
            return res.status(404).json({ error: "Meter not found" });
        }

        // 2. Call our SMT service to "fetch" data
        const syncDetails = await fetchSmtData(meter.rows[0].esiid);

        res.json({
            message: "Synchronization successful!",
            data: syncDetails
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Sync failed" });
    }
});