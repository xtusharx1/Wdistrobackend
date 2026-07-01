const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const { Op, literal } = require('sequelize');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const ProductVariationGroup = require('../models/ProductVariationGroup');

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

const CATEGORY_MAP = {
  'General Merchandise': ['Cables', 'Toys', 'Misc', 'Clothing', 'Supplements', 'Medicine (OTC)'],
  'Glass': ['Glass Rigs', 'Glass Accessories', 'Grinders'],
  'Tobacco': ['Wraps', 'Cigars', 'Cigarillos', 'Rolling Tobacco', 'Chew/Pouches'],
  'Lighters': ['Pocket Torches', 'High Flame', 'Butane', 'Torch Lighters'],
  'Vape': ['Disposable', 'Hardware', 'Vape Accessories', 'Juices'],
  'Rolling Papers': ['Papers', 'Rolling Machine', 'Tips', 'Cones']
};

const mapCategoryFromText = (name, desc, mainCatInput, subCatInput) => {
  const text = `${name || ''} ${desc || ''} ${mainCatInput || ''} ${subCatInput || ''}`.toLowerCase();
  
  if (/\b(gummy|gummies|kanna|kratom|gumm)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Supplements' };
  }
  if (/\b(energy|energy\s*drink|5\s*hour|5-hour)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Supplements' };
  }
  if (/\b(liquid\s*gel|liquid\s*gels|gel\s*cap|gel\s*caps|capsule|capsules|tablet|tablets)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Medicine (OTC)' };
  }
  
  // Vape matching
  if (/\b(disposable|disposables|geek\s*bar|lost\s*mary|elf\s*bar|vuse|flum|fume|hqd|breeze|mr\s*fog|puff\s*bar|packspod|ebdesign|raz|viho|kadobar|oxbar|vaping)\b/.test(text)) {
    return { mainCat: 'Vape', subCat: 'Disposable' };
  }
  if (/\b(juice|juices|liquid|e-liquid|eliquid|e-juice|ejuice|salt\s*nic|nic\s*salt|pod\s*juice)\b/.test(text)) {
    return { mainCat: 'Vape', subCat: 'Juices' };
  }
  if (/\b(coil|coils|empty\s*pod|empty\s*pods|cartridge|cartridges)\b/.test(text)) {
    return { mainCat: 'Vape', subCat: 'Vape Accessories' };
  }
  if (/\b(mod|vape\s*kit|starter\s*kit|vape\s*device|battery|vaporizer|tanks)\b/.test(text) || /\bvape\b/.test(text)) {
    return { mainCat: 'Vape', subCat: 'Hardware' };
  }

  // Tobacco matching
  if (/\b(wrap|wraps|hemp\s*wrap|hemp\s*wraps|fronto|grabba|loose\s*leaf|king\s*palm|zig\s*zag\s*wrap)\b/.test(text)) {
    return { mainCat: 'Tobacco', subCat: 'Wraps' };
  }
  if (/\b(cigarillo|cigarillos|swisher|white\s*owl|dutch\s*masters|game\s*cigar)\b/.test(text)) {
    return { mainCat: 'Tobacco', subCat: 'Cigarillos' };
  }
  if (/\b(cigar|cigars)\b/.test(text)) {
    return { mainCat: 'Tobacco', subCat: 'Cigars' };
  }
  if (/\b(rolling\s*tobacco|pipe\s*tobacco|loose\s*tobacco)\b/.test(text)) {
    return { mainCat: 'Tobacco', subCat: 'Rolling Tobacco' };
  }
  if (/\b(chew|chews|pouch|pouches|snus|dip|snuff|zyn|velo|rogue)\b/.test(text) || /\btobacco\b/.test(text)) {
    return { mainCat: 'Tobacco', subCat: 'Chew/Pouches' };
  }

  // Rolling Papers matching
  if (/\b(cone|cones|raw\s*cone|raw\s*cones|pre-rolled\s*cone)\b/.test(text)) {
    return { mainCat: 'Rolling Papers', subCat: 'Cones' };
  }
  if (/\b(tip|tips|filter\s*tip|filter\s*tips|crutch|crutches)\b/.test(text)) {
    return { mainCat: 'Rolling Papers', subCat: 'Tips' };
  }
  if (/\b(roller|rolling\s*machine|rolling\s*machines|joint\s*roller)\b/.test(text)) {
    return { mainCat: 'Rolling Papers', subCat: 'Rolling Machine' };
  }
  if (/\b(paper|papers|rolling\s*paper|rolling\s*papers|raw|elements|ocb|zig\s*zag)\b/.test(text)) {
    return { mainCat: 'Rolling Papers', subCat: 'Papers' };
  }

  // Glass matching
  if (/\b(rig|rigs|dab\s*rig|bong|bongs|waterpipe|waterpipes|water\s*pipe|bubbler|recycler)\b/.test(text)) {
    return { mainCat: 'Glass', subCat: 'Glass Rigs' };
  }
  if (/\b(bowl|bowls|slide|banger|bangers|downstem|downstems|ash\s*catcher|carb\s*cap|glass\s*screen|glass\s*pipe|glass\s*pipes|spoon\s*pipe|hand\s*pipe)\b/.test(text)) {
    return { mainCat: 'Glass', subCat: 'Glass Accessories' };
  }
  if (/\b(grinder|grinders)\b/.test(text) || /\bglass\b/.test(text)) {
    return { mainCat: 'Glass', subCat: 'Grinders' };
  }

  // Lighters matching
  if (/\b(butane|butane\s*gas|refill)\b/.test(text)) {
    return { mainCat: 'Lighters', subCat: 'Butane' };
  }
  if (/\b(pocket\s*torch|mini\s*torch)\b/.test(text)) {
    return { mainCat: 'Lighters', subCat: 'Pocket Torches' };
  }
  if (/\b(high\s*flame|blowtorch)\b/.test(text)) {
    return { mainCat: 'Lighters', subCat: 'High Flame' };
  }
  if (/\b(torch\s*lighter|torch\s*lighters)\b/.test(text)) {
    return { mainCat: 'Lighters', subCat: 'Torch Lighters' };
  }
  if (/\b(lighter|lighters|clipper|bic|zippo)\b/.test(text)) {
    return { mainCat: 'Lighters', subCat: 'Pocket Torches' };
  }

  // General Merchandise matching
  if (/\b(cable|cables|charger|chargers|usb|type-c|lightning\s*cable|charging\s*cord)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Cables' };
  }
  if (/\b(toy|toys|plush|novelty)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Toys' };
  }
  if (/\b(clothing|t-shirt|tshirt|hoodie|cap|hat|socks|apparel)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Clothing' };
  }
  if (/\b(supplement|supplements|cbd|gummy|gummi|kratom|kava|nootropic|vitamins)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Supplements' };
  }
  if (/\b(medicine|otc|advil|tylenol|aspirin|ibuprofen|pain\s*relief|allergy)\b/.test(text)) {
    return { mainCat: 'General Merchandise', subCat: 'Medicine (OTC)' };
  }

  return { mainCat: 'General Merchandise', subCat: 'Misc' };
};

const resolveCategories = (name, description, mainCategory, subCategory) => {
  let mainCat = 'General Merchandise';
  let subCat = 'Misc';
  
  if (mainCategory) {
    const cleanedMain = String(mainCategory).trim().toLowerCase();
    const matchedKey = Object.keys(CATEGORY_MAP).find(
      (key) => key.toLowerCase() === cleanedMain
    );
    if (matchedKey) {
      mainCat = matchedKey;
      subCat = CATEGORY_MAP[matchedKey][0] || 'Misc';
      
      if (subCategory) {
        const cleanedSub = String(subCategory).trim().toLowerCase();
        const matchedSub = CATEGORY_MAP[matchedKey].find(
          (sub) => sub.toLowerCase() === cleanedSub
        );
        if (matchedSub) {
          subCat = matchedSub;
        } else {
          subCat = String(subCategory).trim();
        }
      } else {
        const detected = mapCategoryFromText(name, description, mainCategory, subCategory);
        if (detected.mainCat === matchedKey) {
          subCat = detected.subCat;
        }
      }
    } else {
      let foundMatch = false;
      for (const [key, subs] of Object.entries(CATEGORY_MAP)) {
        const matchedSub = subs.find(sub => sub.toLowerCase() === cleanedMain);
        if (matchedSub) {
          mainCat = key;
          subCat = matchedSub;
          foundMatch = true;
          break;
        }
      }
      if (!foundMatch) {
        const detected = mapCategoryFromText(name, description, mainCategory, subCategory);
        if (detected.mainCat !== 'General Merchandise' || detected.subCat !== 'Misc') {
          mainCat = detected.mainCat;
          subCat = detected.subCat;
        } else {
          mainCat = String(mainCategory).trim();
          subCat = subCategory ? String(subCategory).trim() : 'Misc';
        }
      }
    }
  } else {
    const detected = mapCategoryFromText(name, description, mainCategory, subCategory);
    mainCat = detected.mainCat;
    subCat = detected.subCat;
  }
  
  if (mainCat === 'General Merchandise' && subCat === 'Misc') {
    const detected = mapCategoryFromText(name, description, mainCategory, subCategory);
    if (detected.mainCat !== 'General Merchandise' || detected.subCat !== 'Misc') {
      mainCat = detected.mainCat;
      subCat = detected.subCat;
    }
  }
  
  return { mainCat, subCat };
};

// Create product
router.post('/', async (req, res) => {
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id, description, bypassDuplicateCheck, is_active, is_clearance, clearance_price, is_featured, featured_order } = req.body;
  if (!name || price === undefined || stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'Name, price, and stock_quantity are required' });
  }

  const { mainCat, subCat } = resolveCategories(name, description, mainCategory || main_category, subCategory || sub_category || category);
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

    const isClearance = is_clearance === true || is_clearance === 'true';
    let parsedClearancePrice = null;
    if (isClearance) {
      if (clearance_price === undefined || clearance_price === null || clearance_price === '') {
        return res.status(400).json({ success: false, message: 'Clearance price is required when product is marked as clearance.' });
      }
      parsedClearancePrice = parseFloat(clearance_price);
      if (isNaN(parsedClearancePrice) || parsedClearancePrice <= 0) {
        return res.status(400).json({ success: false, message: 'Clearance price must be greater than zero.' });
      }
      if (parsedClearancePrice >= parseFloat(price)) {
        return res.status(400).json({ success: false, message: 'Clearance price must be less than the regular selling price.' });
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
      is_active: is_active !== undefined ? is_active : (stock_quantity > 0),
      image_url,
      sku_id,
      description,
      is_clearance: isClearance,
      clearance_price: parsedClearancePrice,
      is_featured: is_featured === true || is_featured === 'true',
      featured_order: featured_order !== undefined && featured_order !== null ? parseInt(featured_order) : null
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
        const { mainCat, subCat } = resolveCategories(p.name, p.description, p.mainCategory || p.main_category, p.subCategory || p.sub_category || p.category);
        const reqLicense = p.requiredLicense || p.required_license || ((mainCat === 'Tobacco' || mainCat === 'Vape') ? 'Tobacco License' : 'Seller Permit');
        const isClearance = p.is_clearance === true || p.is_clearance === 'true';
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
          is_active: p.is_active !== undefined ? p.is_active : (p.stock_quantity > 0),
          image_url: p.image_url || null,
          description: p.description || null,
          is_clearance: isClearance,
          clearance_price: isClearance && p.clearance_price !== undefined && p.clearance_price !== null ? parseFloat(p.clearance_price) : null
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
    const { page, limit, search, main_category, mainCategory, sub_category, subCategory, sortBy, sortOrder, stockFilter, is_active, clearance } = req.query;
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

    // Clearance filter: ?clearance=true → only clearance, ?clearance=false → only regular
    if (clearance === 'true') {
      whereClause.is_clearance = true;
    } else if (clearance === 'false') {
      whereClause.is_clearance = false;
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

// Barcode / QR scan lookup — registered before /:id so 'scan' isn't treated as an id
// GET /products/scan/:code — searches by sku_id; respects all existing business rules
router.get('/scan/:code', async (req, res) => {
  const code = req.params.code.trim();
  const shopId = req.headers['x-shop-id'];
  const userRole = req.headers['x-user-role'];

  if (!code) {
    return res.status(400).json({ success: false, message: 'Scan code is required' });
  }

  try {
    const whereClause = { sku_id: code };
    if (shopId) whereClause.is_active = true; // shop context: active-only

    const product = await Product.findOne({ where: whereClause });
    if (!product) {
      return res.status(404).json({ success: false, message: 'No product found for this barcode' });
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
    if (userRole !== 'Admin') delete p.purchase_cost;

    return res.json({ success: true, message: 'Product fetched successfully', data: { product: p } });
  } catch (err) {
    console.error('Error scanning product:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get featured products — active featured products sorted by featured_order ASC, newest last
// Must be registered before /:id so Express doesn't treat 'featured' as an id
router.get('/featured', async (req, res) => {
  const shopId = req.headers['x-shop-id'];
  const userRole = req.headers['x-user-role'];

  try {
    const whereClause = { is_featured: true, is_active: true };

    if (shopId) {
      const shop = await Shop.findByPk(shopId);
      if (shop) {
        const allowedLicenses = [];
        if (shop.seller_permit && shop.approved) allowedLicenses.push('Seller Permit');
        if (shop.tobacco_license && shop.approved) allowedLicenses.push('Tobacco License');
        whereClause.required_license = { [Op.in]: allowedLicenses };
      }
    }

    const products = await Product.findAll({
      where: whereClause,
      order: [
        ['featured_order', 'ASC'],
        ['created_at', 'DESC'],
        ['id', 'DESC'],
      ]
    });

    const sanitized = products.map(p => {
      const j = p.toJSON();
      if (userRole !== 'Admin') delete j.purchase_cost;
      return j;
    });

    return res.json({ success: true, message: 'Featured products fetched successfully', data: { products: sanitized } });
  } catch (err) {
    console.error('Error fetching featured products:', err);
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

    // Attach variation group members (all other products in the same group)
    const group = await ProductVariationGroup.findOne({
      where: literal(`${parseInt(id)} = ANY("product_ids")`)
    });

    let variations = [];
    if (group) {
      const variantIds = group.product_ids.filter(pid => pid !== parseInt(id));
      if (variantIds.length > 0) {
        const variantWhere = { id: { [Op.in]: variantIds } };
        if (shopId) {
          variantWhere.is_active = true;
          const variantShop = await Shop.findByPk(shopId);
          if (variantShop) {
            const allowedLicenses = [];
            if (variantShop.seller_permit && variantShop.approved) allowedLicenses.push('Seller Permit');
            if (variantShop.tobacco_license && variantShop.approved) allowedLicenses.push('Tobacco License');
            variantWhere.required_license = { [Op.in]: allowedLicenses };
          }
        }
        const variantProducts = await Product.findAll({ where: variantWhere });
        variations = variantProducts.map(vp => {
          const j = vp.toJSON();
          if (userRole !== 'Admin') delete j.purchase_cost;
          return j;
        });
      }
    }

    p.variations = variations;
    p.variation_group_id = group?.id || null;

    return res.json({ success: true, message: 'Product fetched successfully', data: { product: p } });
  } catch (err) {
    console.error('Error fetching product details:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update product
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id, description, is_active, is_clearance, clearance_price, is_featured, featured_order } = req.body;

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

    if (stock_quantity !== undefined) {
      product.stock_quantity = stock_quantity;
      if (is_active === undefined) {
        product.is_active = stock_quantity > 0;
      }
    }
    if (image_url !== undefined) product.image_url = image_url;
    if (description !== undefined) product.description = description;

    // Clearance fields
    if (is_clearance !== undefined) {
      const isClearance = is_clearance === true || is_clearance === 'true';
      product.is_clearance = isClearance;
      if (!isClearance) {
        product.clearance_price = null;
      } else if (clearance_price !== undefined && clearance_price !== null) {
        product.clearance_price = parseFloat(clearance_price);
      }
    } else if (clearance_price !== undefined) {
      product.clearance_price = clearance_price !== null ? parseFloat(clearance_price) : null;
    }

    if (is_featured !== undefined) product.is_featured = is_featured === true || is_featured === 'true';
    if (featured_order !== undefined) product.featured_order = featured_order !== null ? parseInt(featured_order) : null;

    // Validate final clearance state before saving
    if (product.is_clearance) {
      if (product.clearance_price === null || product.clearance_price === undefined) {
        return res.status(400).json({ success: false, message: 'Clearance price is required when product is marked as clearance.' });
      }
      if (product.clearance_price <= 0) {
        return res.status(400).json({ success: false, message: 'Clearance price must be greater than zero.' });
      }
      if (product.clearance_price >= product.price) {
        return res.status(400).json({ success: false, message: 'Clearance price must be less than the regular selling price.' });
      }
    }

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
    product.is_active = stock_quantity > 0;
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