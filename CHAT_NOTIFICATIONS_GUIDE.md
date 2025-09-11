# Real-time Chat Notifications Implementation Guide

## Overview
This implementation provides real-time chat notifications using Firebase Cloud Messaging (FCM) with topics and Socket.IO for your Flutter app. The system sends notifications for:
- New chat messages (while user is offline or not actively viewing the chat)
- New chat creation (private and group chats)
- Being added to group chats

## Firebase Topics Structure
Each chat gets its own Firebase topic: `chat_{chatId}`
- Example: Chat with ID 123 → Topic: `chat_123`
- Users are automatically subscribed/unsubscribed when joining/leaving chats

## Socket.IO Integration

### Connection Setup
When connecting to Socket.IO, pass the FCM token:
```javascript
// Example connection
const socket = io('your-server-url', {
  query: {
    userId: currentUserId,
    fcmToken: fcmToken  // ← Add this
  }
});
```

### New Socket Events
```javascript
// Join a chat (subscribes to FCM topic)
socket.emit('joinChat', chatId);

// Leave a chat (unsubscribes from FCM topic)
socket.emit('leaveChat', chatId);

// Mark messages as read (existing)
socket.emit('markAsRead', { chatId, lastSeenMessageId });
```

## API Endpoints

### 1. Update FCM Token (Existing in your authController)
**POST** `/api/me/fcm-token`
```json
{
  "fcmToken": "your-fcm-token-here"
}
```
**Response:**
```json
{
  "message": "FCM token updated successfully",
  "subscribedToChats": 5
}
```

### 2. Subscribe to Chat Topic (New endpoint added)
**POST** `/api/chat/{chatId}/subscribe`
```json
// No body required - uses stored FCM token
```
**Response:**
```json
{
  "message": "Successfully subscribed to chat notifications"
}
```

## FCM Notification Payloads

### New Message Notification
```json
{
  "notification": {
    "title": "John Doe", // or "John Doe in Group Name" for groups
    "body": "Hello there!" // or "📷 Photo" for images
  },
  "data": {
    "type": "new_message",
    "chatId": "123",
    "messageId": "456",
    "senderId": "789",
    "senderUsername": "john_doe",
    "isGroup": "false",
    "chatName": "Group Name", // empty for private chats
    "imageUrl": "", // if message contains image
    "timestamp": "1642694400000"
  }
}
```

### New Chat Notification
```json
{
  "notification": {
    "title": "New chat with John Doe", // or "New group: Group Name"
    "body": "You have a new chat" // or "John Doe added you to a group chat"
  },
  "data": {
    "type": "new_chat",
    "chatId": "123",
    "creatorId": "789",
    "creatorUsername": "john_doe",
    "isGroup": "false",
    "chatName": "Group Name",
    "chatImageUrl": "",
    "timestamp": "1642694400000"
  }
}
```

## Flutter Implementation Guidelines

### 1. FCM Setup
```dart
// Configure FCM in your main.dart
await Firebase.initializeApp();
FirebaseMessaging messaging = FirebaseMessaging.instance;

// Request permission
NotificationSettings settings = await messaging.requestPermission();

// Get FCM token
String? token = await messaging.getToken();

// Send token to backend (your existing endpoint)
await updateFCMToken(token);

// Function to call your existing API
Future<void> updateFCMToken(String? token) async {
  if (token != null) {
    await http.post(
      Uri.parse('$baseUrl/api/me/fcm-token'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $authToken',
      },
      body: jsonEncode({'fcmToken': token}),
    );
  }
}
```

### 2. Notification Channels (Android)
Create these notification channels for better UX:
```dart
// In your Android setup
const AndroidNotificationChannel chatMessagesChannel = AndroidNotificationChannel(
  'chat_messages',
  'Chat Messages',
  description: 'Notifications for new chat messages',
  importance: Importance.high,
);

const AndroidNotificationChannel newChatsChannel = AndroidNotificationChannel(
  'new_chats',
  'New Chats',
  description: 'Notifications for new chats',
  importance: Importance.high,
);
```

### 3. Handle Foreground Notifications
```dart
FirebaseMessaging.onMessage.listen((RemoteMessage message) {
  if (message.data['type'] == 'new_message') {
    // Handle new message while app is open
    // Maybe show in-app notification or update chat list
  } else if (message.data['type'] == 'new_chat') {
    // Handle new chat while app is open
    // Refresh chat list
  }
});
```

### 4. Handle Background/Terminated Notifications
```dart
FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
  // Handle notification tap when app is in background
  _handleNotificationTap(message);
});

// Check for notification that opened the app
RemoteMessage? initialMessage = await FirebaseMessaging.instance.getInitialMessage();
if (initialMessage != null) {
  _handleNotificationTap(initialMessage);
}

void _handleNotificationTap(RemoteMessage message) {
  if (message.data['type'] == 'new_message') {
    // Navigate to specific chat
    String chatId = message.data['chatId']!;
    Navigator.pushNamed(context, '/chat', arguments: chatId);
  } else if (message.data['type'] == 'new_chat') {
    // Navigate to chat list or specific chat
    String chatId = message.data['chatId']!;
    Navigator.pushNamed(context, '/chat', arguments: chatId);
  }
}
```

### 5. Socket.IO Integration
```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

IO.Socket socket = IO.io('your-server-url', 
  IO.OptionBuilder()
    .setQuery({
      'userId': currentUserId.toString(),
      'fcmToken': fcmToken,
    })
    .build()
);

// Join chat when entering chat screen
socket.emit('joinChat', chatId);

// Leave chat when exiting chat screen
socket.emit('leaveChat', chatId);

// Listen for real-time messages
socket.on('newMessage', (data) {
  // Handle real-time message
});
```

### 6. FCM Token Management
```dart
// Call this when user logs in or app starts (your existing endpoint)
Future<void> updateFCMToken(String? token) async {
  if (token != null) {
    await http.post(
      Uri.parse('$baseUrl/api/me/fcm-token'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $authToken',
      },
      body: jsonEncode({'fcmToken': token}),
    );
  }
}

// Handle token refresh
FirebaseMessaging.instance.onTokenRefresh.listen((newToken) {
  updateFCMToken(newToken);
});
```

## Best Practices

### 1. Notification Management
- Only show notifications when user is not actively viewing the chat
- Clear notifications when user reads messages
- Use local notification IDs based on chatId for proper grouping

### 2. Topic Subscription
- Automatically subscribe to chat topics when Socket.IO connects
- Handle subscription failures gracefully
- Re-subscribe on app restart and token refresh

### 3. Error Handling
```dart
try {
  await updateFCMToken(token);
} catch (e) {
  // Handle error - maybe retry later
  print('Failed to update FCM token: $e');
}
```

### 4. Battery Optimization
- Use FCM topics instead of individual tokens for group notifications
- Minimize socket connections - disconnect when app goes to background for extended periods
- Use background message handling efficiently

## Testing

### 1. Test Scenarios
- Send message while recipient is online (Socket.IO only)
- Send message while recipient is offline (FCM notification)
- Create new chat (FCM notification to added users)
- Add users to group chat (FCM notification to new members)
- Leave group chat (unsubscribe from topic)

### 2. Debug Tools
- Firebase Console → Cloud Messaging for topic management
- Server logs for FCM delivery status
- Flutter logs for notification handling

## Security Considerations
- FCM tokens are automatically managed and refreshed
- Topics are scoped to individual chats (users only get notifications for chats they're in)
- Server validates chat membership before sending notifications
- No sensitive data in notification payloads (only IDs and basic info)

## Migration Notes
If you're upgrading from an existing system:
1. Update Socket.IO connection to include FCM token
2. Add FCM routes to your API calls
3. Update notification handling in Flutter app
4. Test thoroughly with existing chats

This implementation ensures WhatsApp-like notification behavior while maintaining real-time capabilities through Socket.IO for online users.
