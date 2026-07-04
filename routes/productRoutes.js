const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const { Op, literal } = require('sequelize');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const ProductVariationGroup = require('../models/ProductVariationGroup');
const ProductCollection = require('../models/ProductCollection');
const Category = require('../models/Category');
const xlsx = require('xlsx');

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
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id, description, bypassDuplicateCheck, is_active, is_clearance, clearance_price, is_featured, billing_name, is_explicit_product } = req.body;
  if (!name || price === undefined || stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'Name, price, and stock_quantity are required' });
  }

  const isExplicit = is_explicit_product === true || is_explicit_product === 'true';
  let finalBillingName = null;
  if (isExplicit) {
    if (!billing_name || !billing_name.trim()) {
      return res.status(400).json({ success: false, message: 'Billing Name is required for explicit products' });
    }
    finalBillingName = billing_name.trim();
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

    const { product_collection_id, deal_price } = req.body;
    let parsedDealPrice = null;
    let parsedCollId = null;
    let isClearance = false;
    let parsedClearancePrice = null;

    if (product_collection_id !== undefined && product_collection_id !== null && product_collection_id !== '') {
      parsedCollId = parseInt(product_collection_id);
      if (deal_price === undefined || deal_price === null || deal_price === '') {
        return res.status(400).json({ success: false, message: 'Deal price is required when a Product Collection is selected.' });
      }
      parsedDealPrice = parseFloat(deal_price);
      if (isNaN(parsedDealPrice) || parsedDealPrice <= 0) {
        return res.status(400).json({ success: false, message: 'Deal price must be greater than zero.' });
      }
      if (parsedDealPrice >= parseFloat(price)) {
        return res.status(400).json({ success: false, message: 'Deal price must be less than the regular selling price.' });
      }

      // Sync legacy clearance fields for compatibility
      const coll = await ProductCollection.findByPk(parsedCollId);
      if (coll && coll.name.toLowerCase() === 'clearance') {
        isClearance = true;
        parsedClearancePrice = parsedDealPrice;
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
      is_featured: is_featured === true || is_featured === 'true',
      product_collection_id: parsedCollId,
      deal_price: parsedDealPrice,
      is_clearance: isClearance,
      clearance_price: parsedClearancePrice,
      billing_name: finalBillingName,
      is_explicit_product: isExplicit
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

router.get('/import/template', async (req, res) => {
  try {
    const wb = xlsx.utils.book_new();

    const productsData = [
      {
        'Product Name': 'Premium Glass Rig 10in',
        'SKU': 'GR-10IN-PREM',
        'Barcode': '810012345678',
        'Category': 'Glass',
        'Subcategory': 'Glass Rigs',
        'Description': '10 inch premium borosilicate glass rig with percolator.',
        'Purchase Cost': 15.50,
        'Selling Price': 45.00,
        'Deal Price': '',
        'Product Collection': '',
        'Stock Quantity': 50,
        'Image URL': 'https://wdistro-assets.s3.amazonaws.com/rig.jpg',
        'Featured Product': 'No',
        'Explicit Product': 'No',
        'Billing Name': '',
        'Active': 'Yes'
      },
      {
        'Product Name': 'Strawberry Disposable 5000 Puffs',
        'SKU': 'VAPE-STRAW-5K',
        'Barcode': '810012345689',
        'Category': 'Vape',
        'Subcategory': 'Disposable',
        'Description': '5% Nicotine strawberry flavor rechargeable disposable vape.',
        'Purchase Cost': 4.20,
        'Selling Price': 14.99,
        'Deal Price': 11.99,
        'Product Collection': 'Deals',
        'Stock Quantity': 200,
        'Image URL': 'https://wdistro-assets.s3.amazonaws.com/vape.jpg',
        'Featured Product': 'Yes',
        'Explicit Product': 'No',
        'Billing Name': '',
        'Active': 'Yes'
      },
      {
        'Product Name': 'Restricted Herbal Supplement',
        'SKU': 'EXPLICIT-SUPP-01',
        'Barcode': '810012345690',
        'Category': 'General Merchandise',
        'Subcategory': 'Supplements',
        'Description': 'Restricted supplement for approved stores only.',
        'Purchase Cost': 10.00,
        'Selling Price': 29.99,
        'Deal Price': '',
        'Product Collection': '',
        'Stock Quantity': 100,
        'Image URL': 'https://wdistro-assets.s3.amazonaws.com/supp.jpg',
        'Featured Product': 'No',
        'Explicit Product': 'Yes',
        'Billing Name': 'Herbal Remedy Pack',
        'Active': 'Yes'
      }
    ];

    const wsProducts = xlsx.utils.json_to_sheet(productsData, {
      header: [
        'Product Name', 'SKU', 'Barcode', 'Category', 'Subcategory',
        'Description', 'Purchase Cost', 'Selling Price', 'Deal Price',
        'Product Collection', 'Stock Quantity', 'Image URL',
        'Featured Product', 'Explicit Product', 'Billing Name', 'Active'
      ]
    });

    xlsx.utils.book_append_sheet(wb, wsProducts, 'Products');

    const notesData = [
      {
        'Column Name': 'Product Name',
        'Required': 'Yes',
        'Validation Rules & Description': 'Product display name. Cannot be empty.'
      },
      {
        'Column Name': 'SKU',
        'Required': 'Yes',
        'Validation Rules & Description': 'Unique product inventory code. Matches existing products to update if Update Existing is checked.'
      },
      {
        'Column Name': 'Barcode',
        'Required': 'No',
        'Validation Rules & Description': 'Product barcode/UPC/EAN. Must be unique if supplied.'
      },
      {
        'Column Name': 'Category',
        'Required': 'Yes',
        'Validation Rules & Description': 'Main category. Normalizes to closest existing match (ignores spacing, case, plurals) or creates a new one.'
      },
      {
        'Column Name': 'Subcategory',
        'Required': 'Yes',
        'Validation Rules & Description': 'Subcategory name under Category. Normalizes to closest existing match or creates a new one.'
      },
      {
        'Column Name': 'Description',
        'Required': 'No',
        'Validation Rules & Description': 'Product description details.'
      },
      {
        'Column Name': 'Purchase Cost',
        'Required': 'No',
        'Validation Rules & Description': 'Internal purchase cost. Must be a positive decimal number.'
      },
      {
        'Column Name': 'Selling Price',
        'Required': 'Yes',
        'Validation Rules & Description': 'Regular selling price. Must be a decimal number greater than 0.'
      },
      {
        'Column Name': 'Deal Price',
        'Required': 'No',
        'Validation Rules & Description': 'Promotional price. Required if Product Collection is set. Must be less than Selling Price.'
      },
      {
        'Column Name': 'Product Collection',
        'Required': 'No',
        'Validation Rules & Description': 'Deals, Clearance, New Arrival, etc. Normalizes to closest existing match or creates a new collection.'
      },
      {
        'Column Name': 'Stock Quantity',
        'Required': 'Yes',
        'Validation Rules & Description': 'Initial inventory count. Must be a non-negative integer.'
      },
      {
        'Column Name': 'Image URL',
        'Required': 'No',
        'Validation Rules & Description': 'Public link to the product image.'
      },
      {
        'Column Name': 'Featured Product',
        'Required': 'No',
        'Validation Rules & Description': 'Must be "Yes" or "No". Default is No.'
      },
      {
        'Column Name': 'Explicit Product',
        'Required': 'No',
        'Validation Rules & Description': 'Must be "Yes" or "No". Restricts visibility to authorized stores. Default is No.'
      },
      {
        'Column Name': 'Billing Name',
        'Required': 'No',
        'Validation Rules & Description': 'Required ONLY if Explicit Product = Yes. Alternative name printed on customer-facing invoices.'
      },
      {
        'Column Name': 'Active',
        'Required': 'No',
        'Validation Rules & Description': 'Must be "Yes" or "No". Default is Yes.'
      }
    ];

    const wsNotes = xlsx.utils.json_to_sheet(notesData, {
      header: ['Column Name', 'Required', 'Validation Rules & Description']
    });

    wsNotes['!cols'] = [
      { wch: 20 },
      { wch: 10 },
      { wch: 100 }
    ];

    xlsx.utils.book_append_sheet(wb, wsNotes, 'Guidelines & Validation Notes');

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="wdistro_product_import_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);

  } catch (err) {
    console.error('Error generating import template:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/import', memoryUpload.single('file'), async (req, res) => {
  const updateExisting = req.body.updateExisting === 'true' || req.body.updateExisting === true;

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No import file provided.' });
  }

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);

    let totalRows = rows.length;
    let productsCreated = 0;
    let productsUpdated = 0;
    let categoriesCreated = 0;
    let categoriesNormalized = 0;
    let subcategoriesCreated = 0;
    let subcategoriesNormalized = 0;
    let collectionsCreated = 0;
    let collectionsNormalized = 0;
    const failedRows = [];

    // Load existing mapping collections
    const existingCategoriesList = await Category.findAll();
    const existingCollectionsList = await ProductCollection.findAll();

    const categoriesMap = {};
    existingCategoriesList.forEach(c => {
      categoriesMap[c.category_name.toLowerCase()] = c;
    });

    const collectionsMap = {};
    existingCollectionsList.forEach(c => {
      collectionsMap[c.name.toLowerCase()] = c;
    });

    const textMatches = (str1, str2) => {
      const n1 = cleanString(str1);
      const n2 = cleanString(str2);
      if (n1 === n2) return true;

      const stripSuffixes = (s) => {
        if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
        if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
        return s;
      };
      return stripSuffixes(n1) === stripSuffixes(n2);
    };

    const findClosestMatch = (input, existingMap, keys) => {
      if (!input) return null;
      
      // Try direct match (with basic plural/singular normalization)
      for (const key of keys) {
        if (textMatches(input, key)) {
          const isExact = input.toString().trim().toLowerCase() === key.toLowerCase();
          return { match: existingMap[key], isExact };
        }
      }

      // Try Levenshtein similarity match
      let bestMatchKey = null;
      let bestSim = 0;
      for (const key of keys) {
        const sim = getLevenshteinSimilarity(input, key);
        if (sim >= 0.80 && sim > bestSim) {
          bestSim = sim;
          bestMatchKey = key;
        }
      }

      if (bestMatchKey) {
        return { match: existingMap[bestMatchKey], isExact: false };
      }

      return null;
    };

    const getRowVal = (row, fieldNames) => {
      for (const key of Object.keys(row)) {
        const normalizedKey = key.trim().toLowerCase().replace(/[_\-\s]+/g, '');
        for (const name of fieldNames) {
          const normalizedName = name.toLowerCase().replace(/[_\-\s]+/g, '');
          if (normalizedKey === normalizedName) {
            return row[key];
          }
        }
      }
      return undefined;
    };

    const seenSKUsInFile = new Set();
    const seenBarcodesInFile = new Set();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const pName = getRowVal(row, ['Product Name', 'ProductName', 'Name']);
      const pSku = getRowVal(row, ['SKU', 'SkuId', 'Sku']);
      const pBarcode = getRowVal(row, ['Barcode', 'UPC', 'EAN']);
      const pCategory = getRowVal(row, ['Category', 'Main Category', 'MainCategory']);
      const pSubcategory = getRowVal(row, ['Subcategory', 'Sub Category', 'SubCategory']);
      const pDesc = getRowVal(row, ['Description', 'Desc']);
      const pCost = getRowVal(row, ['Purchase Cost', 'PurchaseCost', 'Cost']);
      const pPrice = getRowVal(row, ['Selling Price', 'SellingPrice', 'Price']);
      const pDealPrice = getRowVal(row, ['Deal Price', 'DealPrice']);
      const pCollection = getRowVal(row, ['Product Collection', 'ProductCollection', 'Collection']);
      const pStock = getRowVal(row, ['Stock Quantity', 'StockQuantity', 'Stock', 'Qty', 'Quantity']);
      const pImage = getRowVal(row, ['Image URL', 'ImageUrl', 'Image']);
      const pFeatured = getRowVal(row, ['Featured Product', 'FeaturedProduct', 'Featured']);
      const pExplicit = getRowVal(row, ['Explicit Product', 'ExplicitProduct', 'Explicit']);
      const pBillingName = getRowVal(row, ['Billing Name', 'BillingName']);
      const pActive = getRowVal(row, ['Active', 'IsActive', 'Is Active']);

      const addFailed = (reason) => {
        failedRows.push({
          rowNumber: rowNum,
          productName: pName || 'Unknown Product',
          errorReason: reason,
          rowData: row
        });
      };

      if (!pName || !pName.toString().trim()) {
        addFailed('Product Name is required.');
        continue;
      }
      if (!pSku || !pSku.toString().trim()) {
        addFailed('SKU is required.');
        continue;
      }
      if (!pCategory || !pCategory.toString().trim()) {
        addFailed('Category is required.');
        continue;
      }
      if (!pSubcategory || !pSubcategory.toString().trim()) {
        addFailed('Subcategory is required.');
        continue;
      }
      if (pPrice === undefined || pPrice === null || pPrice === '') {
        addFailed('Selling Price is required.');
        continue;
      }
      if (pStock === undefined || pStock === null || pStock === '') {
        addFailed('Stock Quantity is required.');
        continue;
      }

      const sellingPrice = parseFloat(pPrice);
      if (isNaN(sellingPrice) || sellingPrice <= 0) {
        addFailed('Selling Price must be a number greater than 0.');
        continue;
      }

      const stockQty = parseInt(pStock, 10);
      if (isNaN(stockQty) || stockQty < 0) {
        addFailed('Stock Quantity cannot be negative.');
        continue;
      }

      const skuTrim = pSku.toString().trim();
      const skuLower = skuTrim.toLowerCase();
      if (seenSKUsInFile.has(skuLower)) {
        addFailed('Duplicate SKU in upload file.');
        continue;
      }
      seenSKUsInFile.add(skuLower);

      let barcodeVal = null;
      if (pBarcode !== undefined && pBarcode !== null && pBarcode !== '') {
        barcodeVal = pBarcode.toString().trim();
        const barcodeLower = barcodeVal.toLowerCase();
        if (seenBarcodesInFile.has(barcodeLower)) {
          addFailed('Duplicate Barcode in upload file.');
          continue;
        }
        seenBarcodesInFile.add(barcodeLower);

        // Check unique barcode in database (must not belong to another product)
        const barcodeExists = await Product.findOne({
          where: {
            sku_id: {
              [Op.and]: [
                { [Op.iLike]: barcodeVal },
                { [Op.notILike]: skuTrim }
              ]
            }
          }
        });
        if (barcodeExists) {
          addFailed(`Barcode ${barcodeVal} is already assigned to another product.`);
          continue;
        }
      }

      // Check SKU uniqueness/existence
      const existingProduct = await Product.findOne({
        where: { sku_id: { [Op.iLike]: skuTrim } }
      });

      if (existingProduct && !updateExisting) {
        addFailed(`Product SKU ${skuTrim} already exists.`);
        continue;
      }

      let isFeatured = false;
      if (pFeatured !== undefined && pFeatured !== null && pFeatured !== '') {
        const val = pFeatured.toString().trim().toLowerCase();
        if (val === 'yes') {
          isFeatured = true;
        } else if (val !== 'no') {
          addFailed('Featured Product must be either Yes or No.');
          continue;
        }
      }

      let isActive = true;
      if (pActive !== undefined && pActive !== null && pActive !== '') {
        const val = pActive.toString().trim().toLowerCase();
        if (val === 'no') {
          isActive = false;
        } else if (val !== 'yes') {
          addFailed('Active must be either Yes or No.');
          continue;
        }
      }

      let isExplicit = false;
      if (pExplicit !== undefined && pExplicit !== null && pExplicit !== '') {
        const val = pExplicit.toString().trim().toLowerCase();
        if (val === 'yes') {
          isExplicit = true;
        } else if (val !== 'no') {
          addFailed('Explicit Product must be either Yes or No.');
          continue;
        }
      }

      let billingName = null;
      if (isExplicit) {
        if (!pBillingName || !pBillingName.toString().trim()) {
          addFailed('Billing Name is required for explicit products.');
          continue;
        }
        billingName = pBillingName.toString().trim();
      }

      let dealPrice = null;
      if (pDealPrice !== undefined && pDealPrice !== null && pDealPrice !== '') {
        dealPrice = parseFloat(pDealPrice);
        if (isNaN(dealPrice) || dealPrice <= 0) {
          addFailed('Deal Price must be a number greater than 0.');
          continue;
        }
        if (dealPrice >= sellingPrice) {
          addFailed('Deal Price must be less than Selling Price.');
          continue;
        }
      }

      let collectionId = null;
      if (pCollection && pCollection.toString().trim()) {
        const collName = pCollection.toString().trim();
        const matchResult = findClosestMatch(collName, collectionsMap, Object.keys(collectionsMap));
        let matchedCollection = null;
        if (matchResult) {
          matchedCollection = matchResult.match;
          if (!matchResult.isExact) {
            collectionsNormalized++;
          }
        } else {
          matchedCollection = await ProductCollection.create({ name: collName, is_active: true });
          collectionsMap[collName.toLowerCase()] = matchedCollection;
          collectionsCreated++;
        }
        collectionId = matchedCollection.id;

        if (dealPrice === null) {
          addFailed('Deal Price is required when a Product Collection is selected.');
          continue;
        }
      }

      if (dealPrice !== null && !collectionId) {
        addFailed('Product Collection is required if Deal Price is provided.');
        continue;
      }

      // Resolve Category and Subcategory
      const catName = pCategory.toString().trim();
      const matchCatResult = findClosestMatch(catName, categoriesMap, Object.keys(categoriesMap));
      let matchedCategory = null;

      if (matchCatResult) {
        matchedCategory = matchCatResult.match;
        if (!matchCatResult.isExact) {
          categoriesNormalized++;
        }
      } else {
        matchedCategory = await Category.create({
          category_name: catName,
          sub_categories: [pSubcategory.toString().trim()],
          is_active: true
        });
        categoriesMap[catName.toLowerCase()] = matchedCategory;
        categoriesCreated++;
      }

      const subName = pSubcategory.toString().trim();
      const existingSubMap = {};
      const subKeys = (matchedCategory.sub_categories || []).map(s => {
        existingSubMap[s.toLowerCase()] = s;
        return s.toLowerCase();
      });

      const matchSubResult = findClosestMatch(subName, existingSubMap, subKeys);
      let resolvedSubName = null;

      if (matchSubResult) {
        resolvedSubName = matchSubResult.match;
        const isExact = subName.toLowerCase() === resolvedSubName.toLowerCase();
        if (!isExact) {
          subcategoriesNormalized++;
        }
      } else {
        resolvedSubName = subName;
        const updatedSubs = [...(matchedCategory.sub_categories || []), resolvedSubName];
        matchedCategory.sub_categories = updatedSubs;
        await matchedCategory.save();
        subcategoriesCreated++;
      }

      const requiredLicense = (matchedCategory.category_name === 'Tobacco' || matchedCategory.category_name === 'Vape') ? 'Tobacco License' : 'Seller Permit';

      const isClearance = Boolean(pCollection) && pCollection.toString().trim().toLowerCase() === 'clearance';

      const productPayload = {
        name: pName.toString().trim(),
        sku_id: barcodeVal || skuTrim, // Store barcode if provided, otherwise SKU
        price: sellingPrice,
        purchase_cost: pCost !== undefined && pCost !== null && pCost !== '' ? parseFloat(pCost) : null,
        category: resolvedSubName,
        main_category: matchedCategory.category_name,
        sub_category: resolvedSubName,
        required_license: requiredLicense,
        stock_quantity: stockQty,
        description: pDesc ? pDesc.toString().trim() : null,
        is_active: isActive,
        is_featured: isFeatured,
        product_collection_id: collectionId,
        deal_price: dealPrice,
        billing_name: billingName,
        is_explicit_product: isExplicit,
        image_url: pImage ? pImage.toString().trim() : null,
        is_clearance: isClearance,
        clearance_price: isClearance ? dealPrice : null
      };

      try {
        if (existingProduct) {
          await existingProduct.update(productPayload);
          productsUpdated++;
        } else {
          await Product.create(productPayload);
          productsCreated++;
        }
      } catch (dbErr) {
        addFailed(`Database error: ${dbErr.message}`);
      }
    }

    return res.json({
      success: true,
      message: 'Product import process finished.',
      summary: {
        totalRows,
        productsCreated,
        productsUpdated,
        categoriesCreated,
        categoriesNormalized,
        subcategoriesCreated,
        subcategoriesNormalized,
        collectionsCreated,
        collectionsNormalized,
        failedRowsCount: failedRows.length
      },
      failedRows
    });

  } catch (err) {
    console.error('Import processing error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process import file.' });
  }
});

// Get products
router.get('/', async (req, res) => {
  try {
    const { page, limit, search, main_category, mainCategory, sub_category, subCategory, sortBy, sortOrder, stockFilter, is_active, collection_id } = req.query;
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

    // Collection filter: ?collection_id=none -> without collection, ?collection_id=ID -> specific collection
    if (collection_id === 'none') {
      whereClause.product_collection_id = null;
    } else if (collection_id && collection_id !== 'All') {
      whereClause.product_collection_id = parseInt(collection_id);
    }

    let allowExplicit = false;
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
        if (shop.allow_explicit_products) {
          allowExplicit = true;
        }
      }
    }

    if (!allowExplicit && shopId) {
      whereClause.is_explicit_product = false;
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
      order: orderClause,
      include: [
        { model: ProductCollection, as: 'ProductCollection', attributes: ['id', 'name', 'is_active'] }
      ]
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
        if (product.is_explicit_product && !shop.allow_explicit_products) {
          return res.status(403).json({ success: false, message: 'Explicit products are not allowed for this store.' });
        }
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

    let allowExplicit = false;
    if (shopId) {
      const shop = await Shop.findByPk(shopId);
      if (shop) {
        const allowedLicenses = [];
        if (shop.seller_permit && shop.approved) allowedLicenses.push('Seller Permit');
        if (shop.tobacco_license && shop.approved) allowedLicenses.push('Tobacco License');
        whereClause.required_license = { [Op.in]: allowedLicenses };
        if (shop.allow_explicit_products) {
          allowExplicit = true;
        }
      }
    }

    if (!allowExplicit && shopId) {
      whereClause.is_explicit_product = false;
    }

    const products = await Product.findAll({
      where: whereClause,
      order: [
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
    const product = await Product.findByPk(id, {
      include: [
        { model: ProductCollection, as: 'ProductCollection', attributes: ['id', 'name', 'is_active'] }
      ]
    });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (shopId) {
      const shop = await Shop.findByPk(shopId);
      if (shop) {
        if (product.is_explicit_product && !shop.allow_explicit_products) {
          return res.status(403).json({ success: false, message: 'Explicit products are not allowed for this store.' });
        }
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
            if (!variantShop.allow_explicit_products) {
              variantWhere.is_explicit_product = false;
            }
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
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id, description, is_active, is_featured, product_collection_id, deal_price, billing_name, is_explicit_product } = req.body;

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    let targetIsExplicit = product.is_explicit_product;
    if (is_explicit_product !== undefined) {
      targetIsExplicit = is_explicit_product === true || is_explicit_product === 'true';
    }

    if (targetIsExplicit) {
      if (billing_name !== undefined) {
        if (!billing_name || !billing_name.trim()) {
          return res.status(400).json({ success: false, message: 'Billing Name is required for explicit products' });
        }
        product.billing_name = billing_name.trim();
      } else {
        if (!product.billing_name || !product.billing_name.trim()) {
          return res.status(400).json({ success: false, message: 'Billing Name is required for explicit products' });
        }
      }
      product.is_explicit_product = true;
    } else {
      product.is_explicit_product = false;
      product.billing_name = null;
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

    // Collection fields
    if (product_collection_id !== undefined) {
      if (product_collection_id === null || product_collection_id === '') {
        product.product_collection_id = null;
        product.deal_price = null;
        product.is_clearance = false;
        product.clearance_price = null;
      } else {
        product.product_collection_id = parseInt(product_collection_id);
        const finalDealPrice = deal_price !== undefined ? deal_price : product.deal_price;
        if (finalDealPrice === undefined || finalDealPrice === null || finalDealPrice === '') {
          return res.status(400).json({ success: false, message: 'Deal price is required when a Product Collection is selected.' });
        }
        const parsedDeal = parseFloat(finalDealPrice);
        if (isNaN(parsedDeal) || parsedDeal <= 0) {
          return res.status(400).json({ success: false, message: 'Deal price must be greater than zero.' });
        }
        if (parsedDeal >= product.price) {
          return res.status(400).json({ success: false, message: 'Deal price must be less than the regular selling price.' });
        }
        product.deal_price = parsedDeal;

        // Auto sync legacy fields for safety
        const coll = await ProductCollection.findByPk(product.product_collection_id);
        if (coll && coll.name.toLowerCase() === 'clearance') {
          product.is_clearance = true;
          product.clearance_price = parsedDeal;
        } else {
          product.is_clearance = false;
          product.clearance_price = null;
        }
      }
    } else if (deal_price !== undefined) {
      if (product.product_collection_id) {
        if (deal_price === null || deal_price === '') {
          return res.status(400).json({ success: false, message: 'Deal price is required when a Product Collection is selected.' });
        }
        const parsedDeal = parseFloat(deal_price);
        if (isNaN(parsedDeal) || parsedDeal <= 0) {
          return res.status(400).json({ success: false, message: 'Deal price must be greater than zero.' });
        }
        if (parsedDeal >= product.price) {
          return res.status(400).json({ success: false, message: 'Deal price must be less than the regular selling price.' });
        }
        product.deal_price = parsedDeal;

        // Auto sync legacy fields for safety
        const coll = await ProductCollection.findByPk(product.product_collection_id);
        if (coll && coll.name.toLowerCase() === 'clearance') {
          product.is_clearance = true;
          product.clearance_price = parsedDeal;
        } else {
          product.is_clearance = false;
          product.clearance_price = null;
        }
      } else {
        product.deal_price = null;
        product.is_clearance = false;
        product.clearance_price = null;
      }
    }

    if (is_featured !== undefined) product.is_featured = is_featured === true || is_featured === 'true';

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