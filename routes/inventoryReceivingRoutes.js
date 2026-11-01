const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const { Op } = require('sequelize');
const sequelize = require('../config/db');
const { InventoryReceipt, InventoryReceiptItem, Product, StockMovement, User } = require('../models');

const router = express.Router();

// Initialize AWS S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  }
});

// Configure Multer S3 storage for supplier invoice upload
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_S3_BUCKET || 'wdistro',
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    contentType: (req, file, cb) => {
      cb(null, file.mimetype);
    },
    contentDisposition: 'inline',
    key: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, 'invoices/' + uniqueSuffix + path.extname(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPG, JPEG, PNG, or WEBP files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper validation for role check
const checkAdminOrSeller = (req, res, next) => {
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  if (!userRole || (userRole !== 'Admin' && userRole !== 'Seller')) {
    return res.status(403).json({ success: false, message: 'Access denied: Administrative privileges required' });
  }

  if (!userId) {
    return res.status(400).json({ success: false, message: 'x-user-id header is required' });
  }

  next();
};

const RECEIPT_INCLUDE = [
  { model: User, as: 'ReceivedBy', attributes: ['id', 'name', 'role'] },
  {
    model: InventoryReceiptItem,
    as: 'items',
    include: [{ model: Product, attributes: ['id', 'name', 'sku_id', 'price', 'stock_quantity'] }]
  }
];

// 1. Upload Invoice File to S3
// POST /inventory-receiving/upload
router.post('/upload', checkAdminOrSeller, (req, res) => {
  upload.single('invoice')(req, res, (err) => {
    if (err) {
      console.error('Invoice S3 Upload Error:', err);
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No invoice file provided' });
    }
    return res.json({
      success: true,
      message: 'Invoice uploaded successfully',
      data: { url: req.file.location }
    });
  });
});

// 2. Create a new Inventory Receipt
// POST /inventory-receiving
// Body: { vendor_name?, vendor_invoice_number?, invoice_url?, remarks?, products: [{ product_id, quantity_received }] }
router.post('/', checkAdminOrSeller, async (req, res) => {
  const userId = req.headers['x-user-id'];
  const {
    vendor_name,
    vendor_invoice_number,
    invoice_url,
    remarks,
    products
  } = req.body;

  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one product is required for inventory receipt' });
  }

  for (const p of products) {
    if (!p.product_id || !p.quantity_received || p.quantity_received < 1) {
      return res.status(400).json({ success: false, message: 'Each received product must have product_id and quantity_received >= 1' });
    }
  }

  // Validate vendor fields
  if (vendor_name !== undefined && vendor_name !== null && (typeof vendor_name !== 'string' || vendor_name.trim().length === 0)) {
    return res.status(400).json({ success: false, message: 'Vendor name must be a non-empty string when provided' });
  }
  if (vendor_invoice_number !== undefined && vendor_invoice_number !== null && (typeof vendor_invoice_number !== 'string' || vendor_invoice_number.trim().length === 0)) {
    return res.status(400).json({ success: false, message: 'Vendor invoice number must be a non-empty string when provided' });
  }

  // Duplicate prevention: when both vendor_name AND vendor_invoice_number are supplied,
  // check that we haven't already recorded this same supplier invoice.
  const cleanVendorName = vendor_name ? vendor_name.trim() : null;
  const cleanVendorInvoiceNo = vendor_invoice_number ? vendor_invoice_number.trim() : null;

  if (cleanVendorName && cleanVendorInvoiceNo) {
    const existing = await InventoryReceipt.findOne({
      where: { vendor_name: cleanVendorName, vendor_invoice_number: cleanVendorInvoiceNo }
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Duplicate entry: Inventory receipt for vendor "${cleanVendorName}" invoice "${cleanVendorInvoiceNo}" has already been recorded (${existing.receipt_number}).`,
        data: { existing_receipt_number: existing.receipt_number, existing_receipt_id: existing.id }
      });
    }
  }

  try {
    const result = await sequelize.transaction(async (t) => {
      // 1. Create the Receipt record with a unique temporary receipt_number
      const tempReceiptNumber = `TEMP-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const receipt = await InventoryReceipt.create({
        receipt_number: tempReceiptNumber,
        vendor_name: cleanVendorName,
        vendor_invoice_number: cleanVendorInvoiceNo,
        invoice_url: invoice_url || null,
        remarks: remarks || null,
        received_by_user_id: parseInt(userId)
      }, { transaction: t });

      // 2. Generate the final receipt number from the auto-generated ID
      receipt.receipt_number = `GRN-${String(receipt.id).padStart(6, '0')}`;
      await receipt.save({ transaction: t });

      const receiptItems = [];

      // 3. Process each product receipt
      for (const p of products) {
        const product = await Product.findByPk(p.product_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!product) {
          throw new Error(`Product with ID ${p.product_id} not found`);
        }

        const prevStock = product.stock_quantity;
        const newStock = prevStock + p.quantity_received;

        // Update product stock (active status is managed separately from stock — Task 12)
        product.stock_quantity = newStock;
        await product.save({ transaction: t });

        // Log StockMovement
        await StockMovement.create({
          product_id: product.id,
          quantity_changed: p.quantity_received,
          previous_stock: prevStock,
          new_stock: newStock,
          order_id: null,
          action: 'Stock Received'
        }, { transaction: t });

        // Build Receipt Item data
        receiptItems.push({
          inventory_receipt_id: receipt.id,
          product_id: product.id,
          quantity_received: p.quantity_received
        });
      }

      // 4. Save all Receipt Items bulk
      await InventoryReceiptItem.bulkCreate(receiptItems, { transaction: t });

      return receipt;
    });

    // Fetch the complete receipt with items and user
    const completedReceipt = await InventoryReceipt.findByPk(result.id, {
      include: RECEIPT_INCLUDE
    });

    return res.status(201).json({
      success: true,
      message: 'Inventory receipt created successfully',
      data: { receipt: completedReceipt }
    });

  } catch (err) {
    // Handle unique constraint violation on vendor invoice number (race condition)
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        success: false,
        message: 'Duplicate entry: An inventory receipt with this vendor and invoice number already exists.'
      });
    }
    console.error('Error saving inventory receipt:', err);
    return res.status(400).json({ success: false, message: err.message || 'Error saving inventory receipt' });
  }
});

// 3. Fetch History of Inventory Receipts
// GET /inventory-receiving
// Query params: search (receipt number, vendor name, or vendor invoice number)
router.get('/', checkAdminOrSeller, async (req, res) => {
  const { search } = req.query;
  let where = {};

  if (search) {
    where = {
      [Op.or]: [
        { receipt_number: { [Op.iLike]: `%${search}%` } },
        { remarks: { [Op.iLike]: `%${search}%` } },
        { vendor_name: { [Op.iLike]: `%${search}%` } },
        { vendor_invoice_number: { [Op.iLike]: `%${search}%` } }
      ]
    };
  }

  try {
    const receipts = await InventoryReceipt.findAll({
      where,
      include: RECEIPT_INCLUDE,
      order: [['created_at', 'DESC']]
    });

    return res.json({
      success: true,
      data: { receipts }
    });
  } catch (err) {
    console.error('Error fetching inventory receipts:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 4. Fetch Details of a Specific Inventory Receipt
// GET /inventory-receiving/:id
router.get('/:id', checkAdminOrSeller, async (req, res) => {
  const { id } = req.params;

  try {
    const receipt = await InventoryReceipt.findByPk(id, {
      include: [
        { model: User, as: 'ReceivedBy', attributes: ['id', 'name', 'role'] },
        {
          model: InventoryReceiptItem,
          as: 'items',
          include: [{ model: Product }]
        }
      ]
    });

    if (!receipt) {
      return res.status(404).json({ success: false, message: 'Inventory receipt not found' });
    }

    return res.json({
      success: true,
      data: { receipt }
    });
  } catch (err) {
    console.error('Error fetching inventory receipt detail:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
