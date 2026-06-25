const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Product = require('./Product');
const Order = require('./Order');

const StockMovement = sequelize.define('StockMovement', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  product_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Product,
      key: 'id'
    },
    allowNull: false
  },
  quantity_changed: { type: DataTypes.INTEGER, allowNull: false },
  previous_stock: { type: DataTypes.INTEGER, allowNull: false },
  new_stock: { type: DataTypes.INTEGER, allowNull: false },
  order_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Order,
      key: 'id'
    },
    allowNull: false
  },
  action: { type: DataTypes.STRING, allowNull: false }, // 'Approval' or 'Cancellation'
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { fields: ['product_id'] },
    { fields: ['order_id'] }
  ]
});

module.exports = StockMovement;
