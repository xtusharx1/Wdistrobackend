const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// A return of delivered goods recorded against an order (credited through a CreditNote)
const OrderReturn = sequelize.define('OrderReturn', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  order_id: { type: DataTypes.INTEGER, allowNull: false },
  invoice_id: { type: DataTypes.INTEGER, allowNull: false },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'rejected'),
    defaultValue: 'approved',
    allowNull: false
  },
  return_date: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  reason: { type: DataTypes.TEXT, allowNull: true },
  total_amount: { type: DataTypes.FLOAT, allowNull: false },
  created_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
  // Client-generated key so a resubmitted form can't record the same return twice
  request_key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  // Admin chose to put the returned quantities back into stock (done once, in the same transaction)
  restock_inventory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  restocked_at: { type: DataTypes.DATE, allowNull: true },
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { fields: ['order_id'] },
    { fields: ['invoice_id'] }
  ]
});

module.exports = OrderReturn;
