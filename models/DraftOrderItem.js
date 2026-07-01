const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const DraftOrderItem = sequelize.define('DraftOrderItem', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  draft_order_id: { type: DataTypes.INTEGER, allowNull: false },
  product_id: { type: DataTypes.INTEGER, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  price_at_save: { type: DataTypes.FLOAT, allowNull: false },
  custom_price: { type: DataTypes.FLOAT, allowNull: true },
}, {
  timestamps: false,
  indexes: [
    { fields: ['draft_order_id'] },
    { fields: ['product_id'] }
  ]
});

module.exports = DraftOrderItem;
