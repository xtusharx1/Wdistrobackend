const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: process.env.DB_DIALECT,
    logging: false,
    ...(process.env.DB_HOST !== 'localhost' && {
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      }
    })
  }
);

sequelize.authenticate()
  .then(() => console.log("Connected to AWS RDS ✅"))
  .catch(err => console.log("Unable to connect to AWS RDS ❌", err));

module.exports = sequelize;
