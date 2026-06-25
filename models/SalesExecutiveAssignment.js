const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');
const Shop = require('./Shop');

const SalesExecutiveAssignment = sequelize.define('SalesExecutiveAssignment', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  sales_exec_id: {
    type: DataTypes.INTEGER,
    references: {
      model: User,
      key: 'id'
    },
    allowNull: false
  },
  shop_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Shop,
      key: 'id'
    },
    allowNull: false
  },
  start_date: { type: DataTypes.DATE, allowNull: false },
  end_date: { type: DataTypes.DATE, allowNull: true }
}, {
  timestamps: false,
  indexes: [
    { fields: ['sales_exec_id'] },
    { fields: ['shop_id'] }
  ]
});

module.exports = SalesExecutiveAssignment;