const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Shop = require('./Shop');

const Order = sequelize.define('Order', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  shop_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Shop,
      key: 'id'
    },
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'processed', 'dispatched', 'delivered', 'completed'),
    defaultValue: 'pending',
    allowNull: false
  },
  total_amount: { type: DataTypes.FLOAT, allowNull: false },
  approved_at: { type: DataTypes.DATE, allowNull: true },
  dispatched_at: { type: DataTypes.DATE, allowNull: true },
  delivered_at: { type: DataTypes.DATE, allowNull: true }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = Order;