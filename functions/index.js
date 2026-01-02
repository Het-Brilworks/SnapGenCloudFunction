/**
 * Firebase Cloud Functions (v2)
 */

const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();
const db = getFirestore();


const RAZORPAY_KEY = defineSecret("RAZORPAY_KEY");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
const RAZORPAY_WEBHOOK_SECRET = defineSecret("RAZORPAY_WEBHOOK_SECRET");

// // Global limits
// setGlobalOptions({
//   region: "asia-south1",
//   maxInstances: 10,
// });

/* --------------------------------------------------
   Helper
-------------------------------------------------- */

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  return request.auth.uid;
}

function analyticsRef(userId) {
  return db
    .collection("users")
    .doc(userId)
    .collection("analytics")
    .doc("stats");
}

/**
 * Send FCM notification to a user and create notification document
 * @param {string} userId - The user ID
 * @param {string} fcmToken - The FCM token of the user
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {string} imageUrl - Optional image URL
 * @param {object} additionalData - Optional additional data to store in notification doc
 */
async function sendNotification(
  userId,
  fcmToken,
  title,
  body,
  imageUrl = null,
  additionalData = {}
) {
  if (!fcmToken) {
    logger.warn("No FCM token provided");
    return;
  }

  if (!userId) {
    logger.warn("No userId provided");
    return;
  }

  try {
    const message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: {
        initialPageName: "/(user)/notification",
      },
      android: {
        notification: {
          channelId: "default", // REQUIRED for Android 8+
          sound: "default",
        },
      },
      apns: {
        payload: {
          aps: {
            category: "GENERAL_NOTIFICATION",
            contentAvailable: true,
            sound: "default",
          },
        },
      },
    };

    // Add image if provided
    if (imageUrl) {
      message.notification.imageUrl = imageUrl;
    }

    // Send FCM notification
    await getMessaging().send(message);

    // Create notification document in Firestore
    const notificationData = {
      title,
      body,
      userId: userId,
      createdAt: FieldValue.serverTimestamp(),
      read: false,
      ...additionalData,
    };

    // Add imageUrl if provided
    if (imageUrl) {
      notificationData.imageUrl = imageUrl;
    }

    await db.collection("notifications").add(notificationData);

    logger.info(`Notification sent and saved successfully for user: ${userId}`);
  } catch (error) {
    logger.error("Failed to send notification:", error);
  }
}

/* --------------------------------------------------
   Increment Views
-------------------------------------------------- */

exports.incrementViews = onCall(async (request) => {
  requireAuth(request);
  const { creatorId, creationId } = request.data;

  if (!creatorId) {
    throw new HttpsError("invalid-argument", "creatorId is required");
  }

  if (!creationId) {
    throw new HttpsError("invalid-argument", "creationId is required");
  }

  let views = 0;

  try {
    await db.runTransaction(async (tx) => {
      const analyticsDocRef = analyticsRef(creatorId);
      const creationDocRef = db.collection("creations").doc(creationId);

      const [analyticsSnap, creationSnap] = await Promise.all([
        tx.get(analyticsDocRef),
        tx.get(creationDocRef),
      ]);

      if (!analyticsSnap.exists) {
        views = 1;
        tx.set(analyticsDocRef, {
          views: 1,
          public: 0,
          creation: 0,
        });
      } else {
        views = (analyticsSnap.data().views || 0) + 1;
        tx.update(analyticsDocRef, {
          views: FieldValue.increment(1),
        });
      }

      if (creationSnap.exists) {
        tx.update(creationDocRef, {
          views: FieldValue.increment(1),
        });
      }
    });

    return { success: true, views };
  } catch (err) {
    logger.error("incrementViews failed", err);
    throw new HttpsError("internal", "Failed to increment views");
  }
});

/* --------------------------------------------------
   Creation Created
-------------------------------------------------- */

exports.creationCreated = onCall(async (request) => {
  const userId = requireAuth(request);
  let creation = 0;

  try {
    await db.runTransaction(async (tx) => {
      const ref = analyticsRef(userId);
      const snap = await tx.get(ref);

      if (!snap.exists) {
        creation = 1;
        tx.set(ref, {
          views: 0,
          public: 0,
          creation: 1,
        });
      } else {
        creation = (snap.data().creation || 0) + 1;
        tx.update(ref, {
          creation: FieldValue.increment(1),
        });
      }
    });

    return { success: true, creation };
  } catch (err) {
    logger.error("creationCreated failed", err);
    throw new HttpsError("internal", "Failed to update creation count");
  }
});

/* --------------------------------------------------
   Creation Deleted
-------------------------------------------------- */

exports.creationDeleted = onCall(async (request) => {
  const userId = requireAuth(request);
  let creation = 0;

  try {
    await db.runTransaction(async (tx) => {
      const ref = analyticsRef(userId);
      const snap = await tx.get(ref);

      if (!snap.exists) {
        creation = 0;
        tx.set(ref, {
          views: 0,
          public: 0,
          creation: 0,
        });
      } else {
        creation = Math.max(0, (snap.data().creation || 0) - 1);
        tx.update(ref, { creation });
      }
    });

    return { success: true, creation };
  } catch (err) {
    logger.error("creationDeleted failed", err);
    throw new HttpsError("internal", "Failed to decrement creation count");
  }
});

/* --------------------------------------------------
   Creation Made Public
-------------------------------------------------- */

exports.creationMadePublic = onCall(async (request) => {
  const userId = requireAuth(request);
  let publicCount = 0;

  try {
    await db.runTransaction(async (tx) => {
      const ref = analyticsRef(userId);
      const snap = await tx.get(ref);

      if (!snap.exists) {
        publicCount = 1;
        tx.set(ref, {
          views: 0,
          public: 1,
          creation: 0,
        });
      } else {
        publicCount = (snap.data().public || 0) + 1;
        tx.update(ref, {
          public: FieldValue.increment(1),
        });
      }
    });

    return { success: true, public: publicCount };
  } catch (err) {
    logger.error("creationMadePublic failed", err);
    throw new HttpsError("internal", "Failed to increment public count");
  }
});

/* --------------------------------------------------
   Creation Made Private
-------------------------------------------------- */

exports.creationMadePrivate = onCall(async (request) => {
  const userId = requireAuth(request);
  let publicCount = 0;

  try {
    await db.runTransaction(async (tx) => {
      const ref = analyticsRef(userId);
      const snap = await tx.get(ref);

      if (!snap.exists) {
        publicCount = 0;
        tx.set(ref, {
          views: 0,
          public: 0,
          creation: 0,
        });
      } else {
        publicCount = Math.max(0, (snap.data().public || 0) - 1);
        tx.update(ref, { public: publicCount });
      }
    });

    return { success: true, public: publicCount };
  } catch (err) {
    logger.error("creationMadePrivate failed", err);
    throw new HttpsError("internal", "Failed to decrement public count");
  }
});

/* --------------------------------------------------
   Daily Token Reset (Scheduled)
-------------------------------------------------- */

exports.resetTokensDaily = onSchedule(
  {
    schedule: "0 0 * * *",
    region: "asia-south1",
  },
  async () => {
    try {
      const snapshot = await db
        .collection("users")
        .where("tokens", "==", 0)
        .get();

      if (snapshot.empty) return;

      const batch = db.batch();
      const notificationPromises = [];

      snapshot.docs.forEach((doc) => {
        batch.update(doc.ref, { tokens: 1 });

        // Send notification to user about token reset
        const userData = doc.data();
        if (userData.fcmToken) {
          notificationPromises.push(
            sendNotification(
              doc.id,
              userData.fcmToken,
              "Daily Token Reset",
              "Your daily token has been reset. You now have 1 token available!",
              null,
              { type: "token_reset" }
            )
          );
        }
      });

      await batch.commit();
      await Promise.allSettled(notificationPromises);

      logger.info(`Tokens reset for ${snapshot.size} users`);
    } catch (err) {
      logger.error("resetTokensDaily failed", err);
    }
  }
);

/* --------------------------------------------------
   User Analytics Views Milestone Notification
-------------------------------------------------- */

exports.onUserAnalyticsUpdate = onDocumentWritten(
  {
    document: "users/{userId}/analytics/stats",
    region: "asia-south1",
  },
  async (event) => {
    const userId = event.params.userId;
    const beforeData = event.data.before?.data();
    const afterData = event.data.after?.data();

    // Check if document was deleted or doesn't exist
    if (!afterData) return;

    const beforeViews = beforeData?.views || 0;
    const afterViews = afterData?.views || 0;

    // Define milestones
    const milestones = [10, 100, 1000];

    try {
      // Check if we crossed any milestone
      for (const milestone of milestones) {
        if (beforeViews < milestone && afterViews >= milestone) {
          // Get user FCM token
          const userDoc = await db.collection("users").doc(userId).get();

          if (!userDoc.exists) {
            logger.warn(`User ${userId} not found`);
            continue;
          }

          const userData = userDoc.data();
          if (userData.fcmToken) {
            await sendNotification(
              userId,
              userData.fcmToken,
              "🎉 Milestone Achieved!",
              `Congratulations! Your creations have reached ${milestone} total views!`,
              null,
              {
                type: "analytics_milestone",
                milestone: milestone,
                totalViews: afterViews,
              }
            );
            logger.info(
              `Sent ${milestone} views milestone notification to user ${userId}`
            );
          }
        }
      }
    } catch (error) {
      logger.error("onUserAnalyticsUpdate failed:", error);
    }
  }
);

/* --------------------------------------------------
   Creation Views Milestone Notification
-------------------------------------------------- */

exports.onCreationViewsMilestone = onDocumentWritten(
  {
    document: "creations/{creationId}",
    region: "asia-south1",
  },
  async (event) => {
    const creationId = event.params.creationId;
    const beforeData = event.data.before?.data();
    const afterData = event.data.after?.data();

    // Check if document was deleted or doesn't exist
    if (!afterData) return;

    const beforeViews = beforeData?.views || 0;
    const afterViews = afterData?.views || 0;

    // Define milestones
    const milestones = [10, 100, 1000];

    try {
      // Check if we crossed any milestone
      for (const milestone of milestones) {
        if (beforeViews < milestone && afterViews >= milestone) {
          const userId = afterData.userId;
          const imageUrl = afterData.imageURL || null;

          if (!userId) {
            logger.warn(`Creation ${creationId} has no userId`);
            continue;
          }

          // Get user FCM token
          const userDoc = await db.collection("users").doc(userId).get();

          if (!userDoc.exists) {
            logger.warn(`User ${userId} not found for creation ${creationId}`);
            continue;
          }

          const userData = userDoc.data();
          if (userData.fcmToken) {
            await sendNotification(
              userId,
              userData.fcmToken,
              "🎉 Creation Milestone!",
              `One of your creations has reached ${milestone} views!`,
              imageUrl,
              {
                type: "creation_milestone",
                milestone: milestone,
                creationId: creationId,
                creationViews: afterViews,
              }
            );
            logger.info(
              `Sent ${milestone} views milestone notification for creation ${creationId} to user ${userId}`
            );
          }
        }
      }
    } catch (error) {
      logger.error("onCreationViewsMilestone failed:", error);
    }
  }
);

// const TOKEN_PACKS definition
exports.createOrder = onCall(
  { secrets: [RAZORPAY_KEY, RAZORPAY_KEY_SECRET] },
  async (request) => {
    try {
      // 🔐 Auth check
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Login required");
      }
      logger.info("createOrder called by user:", request.auth.uid);
      // 📥 Validate input
      const { packId } = request.data || {};
      if (!packId) {
        throw new HttpsError("invalid-argument", "packId is required");
      }
      logger.info("Requested packId:", packId);

      // 📦 Fetch token packs (single source of truth)
      const snap = await db
        .collection("tokenPacks")
        .limit(1)
        .get();

      if (snap.empty) {
        throw new HttpsError("not-found", "TOKEN_PACKS document missing");
      }
      logger.info("Fetched tokenPacks document");

      const packs = snap.docs[0].data();
      const pack = packs[packId];

      if (!pack) {
        throw new HttpsError("not-found", "Invalid packId");
      }
      logger.info("Selected pack:", packId, pack);

      // 💳 Razorpay
      const razorpay = new Razorpay({
        key_id: RAZORPAY_KEY.value(),
        key_secret: RAZORPAY_KEY_SECRET.value(),
      });
      logger.info("Initialized Razorpay instance");

      // 🧾 Create order
      const order = await razorpay.orders.create({
        amount: pack.amount * 100, // paise
        currency: "INR",
        receipt: `rcpt_${Date.now()}`,
        notes: {
          uid: request.auth.uid,
          packId,
          tokens: pack.tokens,
        },
      });
      logger.info("Created Razorpay order:", order.id);

      return order;

    } catch (err) {
      console.error("createOrder ERROR:", err);

      if (err instanceof HttpsError) {
        throw err;
      }

      throw new HttpsError("internal", "Failed to create order");
    }
  }
);


exports.razorpayWebhook = onRequest(
  { secrets: [RAZORPAY_WEBHOOK_SECRET] },
  async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];

  const expected = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET.value())
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== expected) {
    return res.status(400).send("Invalid signature");
  }

  if (req.body.event === "payment.captured") {
    const payment = req.body.payload.payment.entity;
    const { uid, tokens } = payment.notes;

    if (uid && tokens) {
      await db.collection("users").doc(uid).update({
        tokens: admin.firestore.FieldValue.increment(Number(tokens)),
      });
    }
  }

  res.json({ status: "ok" });
});

