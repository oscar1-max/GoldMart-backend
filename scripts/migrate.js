require('dotenv').config();
const { setupDatabase } = require('../services/databaseSetup');
const pool = require('../db');
setupDatabase().then(() => console.log('Database migrations completed.')).catch(error => {
  console.error('Migration failed:', error.message); process.exitCode = 1;
}).finally(() => pool.end());
