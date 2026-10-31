const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// One returned line; price and name are snapshots of the original order item
const OrderReturnItem = sequelize.define('OrderReturnItem', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  return_id: { type: DataTypes.INTEGER, allowNull: false },
  order_item_id: { type: DataTypes.INTEGER, allowNull: false },
  product_id: { type: DataTypes.INTEGER, allowNull: false },
  product_name: { type: DataTypes.STRING, allowNull: true },
  sku_id: { type: DataTypes.STRING, allowNull: true },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  unit_price: { type: DataTypes.FLOAT, allowNull: false },
  line_total: { type: DataTypes.FLOAT, allowNull: false },
}, {
  timestamps: false,
  indexes: [
    { fields: ['return_id'] },
    { fields: ['order_item_id'] }
  ]
});

module.exports = OrderReturnItem;
