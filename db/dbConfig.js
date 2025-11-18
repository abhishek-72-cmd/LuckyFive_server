// Database configuration
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'luckyfive',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const promisePool = pool.promise();

// Test DB connection
const testConnection = async () => {
  try {
    await promisePool.query('SELECT 1');
    console.log('MySQL Connected Successfully ✔');
    return true;
  } catch (error) {
    console.error('Database connection failed ❌', error);
    return false;
  }
};

module.exports = { pool: promisePool, testConnection };
