require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function seedData() {
  const meterId = 1; // This matches the "id: 1" from your Thunder Client screenshot
  const readings = [];
  
  // Generate 96 readings (24 hours * 4 intervals per hour)
  for (let i = 0; i < 96; i++) {
    const time = new Date();
    time.setMinutes(time.getMinutes() - (i * 15));
    
    // Generate a random energy usage between 0.1 and 1.5 kWh
    const usage = (Math.random() * (1.5 - 0.1) + 0.1).toFixed(4);
    
    readings.push([meterId, time, usage]);
  }

  try {
    for (const reading of readings) {
      await pool.query(
        "INSERT INTO meter_readings (meter_id, read_time, usage_kwh) VALUES ($1, $2, $3)",
        reading
      );
    }
    console.log("Successfully seeded 96 interval readings!");
  } catch (err) {
    console.error("Error seeding data:", err.message);
  } finally {
    pool.end();
  }
}

seedData();