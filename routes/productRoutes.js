const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const { Op } = require('sequelize');
const Product = require('../models/Product');
const Shop = require('../models/Shop');

const router = express.Router();

// Initialize AWS S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  }
});

// Configure Multer S3 storage
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_S3_BUCKET || 'wdistro',
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, 'products/' + uniqueSuffix + path.extname(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      cb(null, true);
    } else {
      cb(new Error('Only images (jpg, jpeg, png, webp) are allowed'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Upload product image
router.post('/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('S3 Upload Error:', err);
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }
    return res.json({
      success: true,
      message: 'Image uploaded successfully',
      data: { image_url: req.file.location }
    });
  });
});

// Clean string: lowercase, remove punctuation, normalize spaces
const cleanString = (str) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

// Calculate Levenshtein Distance
const getLevenshteinDistance = (str1, str2) => {
  const s1 = cleanString(str1);
  const s2 = cleanString(str2);
  const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
  for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;
  for (let j = 1; j <= s2.length; j += 1) {
    for (let i = 1; i <= s1.length; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  return track[s2.length][s1.length];
};

// Calculate Levenshtein Similarity (0.0 to 1.0)
const getLevenshteinSimilarity = (str1, str2) => {
  const s1 = cleanString(str1);
  const s2 = cleanString(str2);
  const maxLength = Math.max(s1.length, s2.length);
  if (maxLength === 0) return 1.0;
  const dist = getLevenshteinDistance(str1, str2);
  return (maxLength - dist) / maxLength;
};

// Create product
router.post('/', async (req, res) => {
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id, description, bypassDuplicateCheck } = req.body;
  if (!name || price === undefined || stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'Name, price, and stock_quantity are required' });
  }

  const mainCat = mainCategory || main_category || 'General Merchandise';
  const subCat = subCategory || sub_category || 'Misc';
  const reqLicense = requiredLicense || required_license || ((mainCat === 'Tobacco' || mainCat === 'Vape') ? 'Tobacco License' : 'Seller Permit');

  try {
    // 1. Check for duplicates if not bypassed
    if (!bypassDuplicateCheck) {
      const existingProducts = await Product.findAll();
      const potentialDuplicates = [];
      for (const p of existingProducts) {
        const similarity = getLevenshteinSimilarity(name, p.name);
        if (similarity >= 0.80) {
          potentialDuplicates.push(p);
        }
      }
      if (potentialDuplicates.length > 0) {
        return res.status(409).json({
          success: false,
          code: 'POTENTIAL_DUPLICATE',
          message: 'A similar product already exists. Please review the existing product before creating a duplicate.',
          data: {
            duplicates: potentialDuplicates
          }
        });
      }
    }

    const product = await Product.create({
      name,
      price,
      purchase_cost,
      category: category || subCat,
      main_category: mainCat,
      sub_category: subCat,
      required_license: reqLicense,
      stock_quantity,
      image_url,
      sku_id,
      description
    });
    return res.status(201).json({ success: true, message: 'Product created successfully', data: { product } });
  } catch (err) {
    console.error('Error creating product:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create multiple products (Bulk Creation)
router.post('/bulk', async (req, res) => {
  const productsInput = req.body;

  if (!Array.isArray(productsInput) || productsInput.length === 0) {
    return res.status(400).json({ success: false, message: 'Request body must be a non-empty array of products' });
  }

  // Validate each product in the array
  for (let i = 0; i < productsInput.length; i++) {
    const { name, price, stock_quantity } = productsInput[i];
    if (!name || price === undefined || stock_quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: `Product at index ${i} is missing required fields (name, price, stock_quantity)`
      });
    }
  }

  try {
    const createdProducts = await Product.bulkCreate(
      productsInput.map(p => {
        const mainCat = p.mainCategory || p.main_category || 'General Merchandise';
        const subCat = p.subCategory || p.sub_category || 'Misc';
        const reqLicense = p.requiredLicense || p.required_license || ((mainCat === 'Tobacco' || mainCat === 'Vape') ? 'Tobacco License' : 'Seller Permit');
        return {
          name: p.name,
          sku_id: p.sku_id || null,
          price: p.price,
          purchase_cost: p.purchase_cost !== undefined ? p.purchase_cost : null,
          category: p.category || subCat,
          main_category: mainCat,
          sub_category: subCat,
          required_license: reqLicense,
          stock_quantity: p.stock_quantity,
          image_url: p.image_url || null,
          description: p.description || null
        };
      })
    );
    return res.status(201).json({ success: true, message: `${createdProducts.length} products created successfully`, data: { products: createdProducts } });
  } catch (err) {
    console.error('Error bulk creating products:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get products
router.get('/', async (req, res) => {
  try {
    const { page, limit, search, main_category, mainCategory, sub_category, subCategory, sortBy, sortOrder, stockFilter, is_active } = req.query;
    const shopId = req.headers['x-shop-id'];

    const whereClause = {};
    if (search) {
      whereClause.name = { [Op.iLike]: `%${search}%` };
    }

    const mainCat = main_category || mainCategory;
    if (mainCat && mainCat !== 'All') {
      whereClause.main_category = mainCat;
    }

    const subCat = sub_category || subCategory;
    if (subCat && subCat !== 'All') {
      whereClause.sub_category = subCat;
    }

    if (stockFilter === 'low_stock') {
      whereClause.stock_quantity = { [Op.gt]: 0, [Op.lt]: 10 };
    } else if (stockFilter === 'out_of_stock') {
      whereClause.stock_quantity = 0;
    }

    if (is_active === 'true' || is_active === true) {
      whereClause.is_active = true;
    } else if (is_active === 'false' || is_active === false) {
      whereClause.is_active = false;
    }

    if (shopId) {
      whereClause.is_active = true;
      const shop = await Shop.findByPk(shopId);
      if (shop) {
        const allowedLicenses = [];
        if (shop.seller_permit && shop.approved) {
          allowedLicenses.push('Seller Permit');
        }
        if (shop.tobacco_license && shop.approved) {
          allowedLicenses.push('Tobacco License');
        }
        whereClause.required_license = { [Op.in]: allowedLicenses };
      }
    }

    let orderClause = [['created_at', 'DESC']];
    if (sortBy) {
      let sortCol = 'created_at';
      if (sortBy === 'name') sortCol = 'name';
      else if (sortBy === 'sku_id' || sortBy === 'sku') sortCol = 'sku_id';
      else if (sortBy === 'price') sortCol = 'price';
      else if (sortBy === 'stock' || sortBy === 'stock_quantity') sortCol = 'stock_quantity';
      else if (sortBy === 'created_at') sortCol = 'created_at';

      const dir = (sortOrder && sortOrder.toLowerCase() === 'asc') ? 'ASC' : 'DESC';
      orderClause = [[sortCol, dir]];
    }
    
    // Always append id as a secondary sorting key to guarantee a stable sort order
    orderClause.push(['id', 'ASC']);

    const options = {
      where: whereClause,
      order: orderClause
    };

    if (limit) {
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit);
      options.limit = limitNum;
      options.offset = (pageNum - 1) * limitNum;
    }

    const { count, rows: products } = await Product.findAndCountAll(options);
    const userRole = req.headers['x-user-role'];
    const sanitizedProducts = products.map(product => {
      const p = product.toJSON();
      if (userRole !== 'Admin') {
        delete p.purchase_cost;
      }
      return p;
    });

    return res.json({ 
      success: true, 
      message: 'Products fetched successfully', 
      data: { 
        products: sanitizedProducts,
        pagination: {
          total: count,
          page: limit ? parseInt(page || 1) : 1,
          limit: limit ? parseInt(limit) : count,
          totalPages: limit ? Math.ceil(count / limit) : 1
        }
      } 
    });
  } catch (err) {
    console.error('Error fetching products:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get product by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const shopId = req.headers['x-shop-id'];
  const userRole = req.headers['x-user-role'];

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (shopId) {
      const shop = await Shop.findByPk(shopId);
      if (shop) {
        if (product.required_license === 'Seller Permit' && !(shop.seller_permit && shop.approved)) {
          return res.status(403).json({ success: false, message: 'Seller Permit Required for this product category.' });
        }
        if (product.required_license === 'Tobacco License' && !(shop.tobacco_license && shop.approved)) {
          return res.status(403).json({ success: false, message: 'Tobacco License Required for this product category.' });
        }
      }
    }

    const p = product.toJSON();
    if (userRole !== 'Admin') {
      delete p.purchase_cost;
    }

    return res.json({ success: true, message: 'Product fetched successfully', data: { product: p } });
  } catch (err) {
    console.error('Error fetching product details:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update product
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id, description, is_active } = req.body;

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (name) product.name = name;
    if (sku_id !== undefined) product.sku_id = sku_id;
    if (price !== undefined) product.price = price;
    if (purchase_cost !== undefined) product.purchase_cost = purchase_cost;
    if (is_active !== undefined) product.is_active = is_active;
    
    const mainCat = mainCategory || main_category;
    if (mainCat) {
      product.main_category = mainCat;
      product.required_license = (mainCat === 'Tobacco' || mainCat === 'Vape') ? 'Tobacco License' : 'Seller Permit';
    }
    
    const subCat = subCategory || sub_category;
    if (subCat) {
      product.sub_category = subCat;
      product.category = subCat;
    }
    
    if (category) product.category = category;
    if (requiredLicense || required_license) {
      product.required_license = requiredLicense || required_license;
    }

    if (stock_quantity !== undefined) product.stock_quantity = stock_quantity;
    if (image_url !== undefined) product.image_url = image_url;
    if (description !== undefined) product.description = description;

    await product.save();
    return res.json({ success: true, message: 'Product updated successfully', data: { product } });
  } catch (err) {
    console.error('Error updating product:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update product stock
router.patch('/:id/stock', async (req, res) => {
  const { id } = req.params;
  const { stock_quantity } = req.body;

  if (stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'stock_quantity is required' });
  }

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    product.stock_quantity = stock_quantity;
    await product.save();
    return res.json({ success: true, message: 'Product stock updated successfully', data: { product } });
  } catch (err) {
    console.error('Error updating stock:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete product
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Check if there are any existing OrderItems referencing this product
    const OrderItem = require('../models/OrderItem');
    const hasOrderItems = await OrderItem.findOne({ where: { product_id: id } });
    if (hasOrderItems) {
      return res.status(400).json({
        success: false,
        message: "This product cannot be deleted because it has existing orders. Please archive or deactivate it instead."
      });
    }

    await product.destroy();
    return res.json({ success: true, message: 'Product deleted successfully', data: null });
  } catch (err) {
    console.error('Error deleting product:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;