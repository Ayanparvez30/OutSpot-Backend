const { notifyUser } = require("./utils/notificationService");

(async () => {
  try {
    const userId = 1; // change to actual user in DB with fcmToken set
    await notifyUser(
      userId,
      "FRIEND_ACCEPTED",
      "Test Push 🚀",
      "This is a test notification from backend",
      { testMode: "true" }
    );
    console.log("✅ Test push sent");
  } catch (err) {
    console.error("❌ Test failed", err);
  }
})();
