const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Order = require('./Order');
const Product = require('./Product');

const OrderItem = sequelize.define('OrderItem', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  order_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Order,
      key: 'id'
    },
    allowNull: false
  },
  product_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Product,
      key: 'id'
    },
    allowNull: false
  },
  requested_qty: { type: DataTypes.INTEGER, allowNull: false },
  approved_qty: { type: DataTypes.INTEGER, allowNull: true },
  price: { type: DataTypes.FLOAT, allowNull: false }
}, {
  timestamps: false
});

module.exports = OrderItem;