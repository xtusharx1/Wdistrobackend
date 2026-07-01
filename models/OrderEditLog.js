const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const OrderEditLog = sequelize.define('OrderEditLog', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  order_id: { type: DataTypes.INTEGER, allowNull: false },
  user_id: { type: DataTypes.INTEGER, allowNull: true },
  action: {
    type: DataTypes.ENUM('item_added', 'item_removed', 'quantity_changed', 'price_changed'),
    allowNull: false
  },
  product_id: { type: DataTypes.INTEGER, allowNull: false },
  product_name: { type: DataTypes.STRING, allowNull: true },
  previous_value: { type: DataTypes.JSON, allowNull: true },
  new_value: { type: DataTypes.JSON, allowNull: true },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { fields: ['order_id'] },
    { fields: ['user_id'] }
  ]
});

module.exports = OrderEditLog;
