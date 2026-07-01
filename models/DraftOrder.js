const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Shop = require('./Shop');

const DraftOrder = sequelize.define('DraftOrder', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  shop_id: {
    type: DataTypes.INTEGER,
    references: { model: Shop, key: 'id' },
    allowNull: false
  },
  total_amount: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['shop_id'] },
    { fields: ['created_at'] }
  ]
});

module.exports = DraftOrder;
