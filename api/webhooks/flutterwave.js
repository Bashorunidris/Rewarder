const crypto = require('crypto');

// Initialize Firebase Admin SDK
const admin = require('firebase-admin');

// Initialize Firebase Admin only once
if (!admin.apps.length) {
  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const db = admin.firestore();

// Flutterwave payment verification
async function verifyFlutterwavePayment(transactionId) {
  try {
    const response = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error verifying payment:', error);
    throw error;
  }
}

// Generate 13-digit ad code
function generateAdCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'AD';
  for (let i = 0; i < 11; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Parse transaction reference to extract eventId
function parseTransactionRef(txRef) {
  // Expected format: boost_${eventId}_${timestamp}
  const parts = txRef.split('_');
  if (parts.length >= 3 && parts[0] === 'boost') {
    return parts[1]; // eventId
  }
  return null;
}

// Main webhook handler
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🔔 Webhook received:', {
      headers: req.headers,
      body: req.body
    });

    // Verify webhook signature
    const hash = crypto
      .createHmac('sha256', process.env.FLUTTERWAVE_WEBHOOK_HASH)
      .update(JSON.stringify(req.body))
      .digest('hex');

    const signature = req.headers['verif-hash'];

    if (hash !== signature) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('✅ Webhook signature verified');

    // Extract webhook data
    const { event, data } = req.body;

    // Only process successful charge events
    if (event !== 'charge.completed' || data.status !== 'successful') {
      console.log('⏭️ Skipping non-successful payment');
      return res.status(200).json({ message: 'Event ignored' });
    }

    console.log('💰 Processing successful payment:', {
      transactionId: data.id,
      amount: data.amount,
      currency: data.currency,
      txRef: data.tx_ref
    });

    // Verify payment with Flutterwave
    const verification = await verifyFlutterwavePayment(data.id);

    if (verification.status !== 'success' || verification.data.status !== 'successful') {
      console.error('❌ Payment verification failed:', verification);
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    console.log('✅ Payment verified with Flutterwave');

    // Extract eventId from transaction reference
    const eventId = parseTransactionRef(data.tx_ref);
    if (!eventId) {
      console.error('❌ Could not extract eventId from tx_ref:', data.tx_ref);
      return res.status(400).json({ error: 'Invalid transaction reference' });
    }

    console.log('📍 Event ID extracted:', eventId);

    // Generate ad code
    const adCode = generateAdCode();
    console.log('🏷️ Generated ad code:', adCode);

    // Create ad package data
    const now = new Date();
    const packageData = {
      packageId: `ads_pkg_${Date.now()}`,
      packageName: 'Webhook Package',
      packageType: 'webhook',
      
      // Status & Timing
      status: 'pending_upload',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000)).toISOString(), // Default 7 days
      
      // Payment Info
      totalAmountPaid: verification.data.amount,
      paymentId: verification.data.id,
      adCode: adCode,
      currency: verification.data.currency,
      
      // Customer Info
      customerEmail: verification.data.customer.email,
      customerName: verification.data.customer.name,
      
      // Webhook metadata
      webhookProcessedAt: now.toISOString(),
      flutterwaveData: {
        txRef: verification.data.tx_ref,
        flwRef: verification.data.flw_ref,
        paymentType: verification.data.payment_type
      },
      
      // Default configuration
      adTypes: ['image'],
      placements: ['app_ads_footer'],
      duration: 7,
      
      // Individual Ad Data
      ads: {
        image: {
          contentType: null,
          dataUrl: null,
          websiteUrl: null,
          editsUsed: 0,
          totalEdits: 1,
          views: 0,
          clicks: 0,
          uploaded: false
        }
      },
      
      // Analytics
      totalViews: 0,
      totalClicks: 0,
      viewsPerDay: {}
    };

    // Save to Firebase
    const adPackagesRef = db.collection('physicalEvents').doc(eventId).collection('adsPackages').doc(packageData.packageId);
    
    await adPackagesRef.set(packageData);

    console.log('✅ Ad package saved to Firebase:', {
      eventId,
      packageId: packageData.packageId,
      adCode
    });

    // Return success response
    res.status(200).json({
      success: true,
      message: 'Payment processed successfully',
      data: {
        eventId,
        packageId: packageData.packageId,
        adCode,
        amount: verification.data.amount
      }
    });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
