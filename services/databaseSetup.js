const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../db');

async function setupDatabase(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Serialize migrations across rolling deployments.
    await client.query('SELECT pg_advisory_xact_lock(70421931)');
    await client.query(await fs.readFile(path.join(__dirname, '../schema.sql'), 'utf8'));
    const directory = path.join(__dirname, '../migrations');
    for (const file of (await fs.readdir(directory)).filter(f => f.endsWith('.sql')).sort()) {
      await client.query(await fs.readFile(path.join(directory, file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
module.exports = { setupDatabase };
