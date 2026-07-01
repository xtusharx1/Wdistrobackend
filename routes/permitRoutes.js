const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const ShopPermit = require('../models/ShopPermit');
const Shop = require('../models/Shop');

const router = express.Router();

// ── Permit type helpers ──────────────────────────────────────────────────────
// Slugs: snake_case URL params (e.g. seller_permit, business_license)
// Labels: display names stored in DB (e.g. "Seller Permit", "Business License")

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

// 'seller_permit' → 'Seller Permit'
function slugToLabel(slug) {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── S3 client ────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  }
});

const permitUpload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_S3_BUCKET || 'wdistro',
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) => {
      const shopId = req.headers['x-shop-id'];
      const slug = req.query.permit_type;

      if (!shopId) return cb(new Error('x-shop-id header is required'));
      if (!isValidSlug(slug)) {
        return cb(new Error('permit_type must be a snake_case identifier (e.g. seller_permit, tobacco_license)'));
      }

      const ext = path.extname(file.originalname).toLowerCase();
      // permits/shop_15/seller_permit/seller_permit.pdf
      cb(null, `permits/shop_${shopId}/${slug}/${slug}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png'];
    const allowedMimes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
    if (allowedExts.includes(ext) && allowedMimes.includes(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Only PDF, JPG, JPEG, PNG files are allowed'));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// ── Upload / Replace permit ──────────────────────────────────────────────────
// POST /permits/upload?permit_type=<slug>
// Headers: x-shop-id
// Body: multipart/form-data { document: <file> }
router.post('/upload', (req, res) => {
  permitUpload.single('document')(req, res, async (err) => {
    if (err) {
      console.error('Permit S3 Upload Error:', err);
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No document file provided' });
    }

    const shopId = parseInt(req.headers['x-shop-id']);
    const slug = req.query.permit_type;

    if (!shopId) return res.status(400).json({ success: false, message: 'x-shop-id header is required' });
    if (!isValidSlug(slug)) {
      return res.status(400).json({ success: false, message: 'permit_type must be a snake_case identifier' });
    }

    const permitType = slugToLabel(slug); // e.g. 'Seller Permit'

    try {
      const shop = await Shop.findByPk(shopId);
      if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

      // Include soft-deleted records so we restore instead of creating a duplicate
      const existing = await ShopPermit.findOne({
        where: { shop_id: shopId, permit_type: permitType },
        paranoid: false
      });

      let permit;
      if (existing) {
        // Restore if soft-deleted, then update fields and reset to Pending
        if (existing.deleted_at !== null) {
          await existing.restore();
        }
        await existing.update({
          document_url: req.file.location,
          original_file_name: req.file.originalname,
          uploaded_by: shopId,
          uploaded_at: new Date(),
          status: 'Pending',
          remarks: null
        });
        permit = existing;
      } else {
        permit = await ShopPermit.create({
          shop_id: shopId,
          permit_type: permitType,
          document_url: req.file.location,
          original_file_name: req.file.originalname,
          uploaded_by: shopId,
          uploaded_at: new Date(),
          status: 'Pending'
        });
      }

      return res.json({
        success: true,
        message: existing ? 'Permit replaced successfully' : 'Permit uploaded successfully',
        data: { permit }
      });
    } catch (dbErr) {
      console.error('Permit DB Error:', dbErr);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });
});

// ── Get all active permits for a shop ───────────────────────────────────────
// GET /permits/shop/:shopId
router.get('/shop/:shopId', async (req, res) => {
  const { shopId } = req.params;
  try {
    const permits = await ShopPermit.findAll({
      where: { shop_id: shopId },
      order: [['created_at', 'DESC']]
      // paranoid: true on model automatically excludes soft-deleted records
    });
    return res.json({ success: true, message: 'Permits fetched successfully', data: { permits } });
  } catch (err) {
    console.error('Error fetching permits:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Get single permit by ID ──────────────────────────────────────────────────
// GET /permits/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const permit = await ShopPermit.findByPk(id);
    if (!permit) return res.status(404).json({ success: false, message: 'Permit not found' });
    return res.json({ success: true, message: 'Permit fetched successfully', data: { permit } });
  } catch (err) {
    console.error('Error fetching permit:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Admin: Approve or Reject a permit ───────────────────────────────────────
// PATCH /permits/:id/review
// Headers: x-user-role: Admin
// Body: { status: 'Approved'|'Rejected', remarks?: string }
router.patch('/:id/review', async (req, res) => {
  const { id } = req.params;
  const { status, remarks } = req.body;
  const userRole = req.headers['x-user-role'];

  if (userRole !== 'Admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  if (!['Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Status must be Approved or Rejected' });
  }
  if (status === 'Rejected' && (!remarks || !remarks.trim())) {
    return res.status(400).json({ success: false, message: 'Remarks are required when rejecting a permit' });
  }

  try {
    const permit = await ShopPermit.findByPk(id);
    if (!permit) return res.status(404).json({ success: false, message: 'Permit not found' });

    permit.status = status;
    permit.remarks = remarks ? remarks.trim() : null;
    await permit.save();

    return res.json({
      success: true,
      message: `Permit ${status.toLowerCase()} successfully`,
      data: { permit }
    });
  } catch (err) {
    console.error('Error reviewing permit:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
