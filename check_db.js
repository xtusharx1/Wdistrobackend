const sequelize = require('./config/db');
require('./models');

async function check() {
  try {
    await sequelize.authenticate();
    console.log('Connected to RDS successfully.');
    
    const [results] = await sequelize.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    
    console.log('Tables in DB:', results.map(r => r.table_name));
    
    for (const table of results.map(r => r.table_name)) {
      const [[countRes]] = await sequelize.query(`SELECT COUNT(*) as count FROM "${table}"`);
      console.log(`Table "${table}" has ${countRes.count} records.`);
    }
  } catch (err) {
    console.error('Error querying DB:', err);
  } finally {
    await sequelize.close();
  }
}

check();
