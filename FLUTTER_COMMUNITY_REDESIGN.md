# Flutter Adjustments — Community Redesign

This document describes every Flutter change needed to support the new community structure. The backend has been updated — this guide tells you exactly what changed, why, and what to do in the Flutter app.

---

## What Changed on the Backend (and Why)

Previously, when you tapped on a community, the API returned a basic list of members with no way to know who the admin was, no chat ID (you had to call a separate endpoint), and no way to know if the current user could leave. Users could also join unlimited communities.

Now:
- **One community per user** — a user can only be in one community at a time. The backend rejects join/create attempts if the user is already in a community.
- **Admin identified** — each member now has an `isAdmin` flag, and the admin is always returned first in the list.
- **Members sorted alphabetically** — after the admin, all other members are sorted A-Z by name. The backend handles this sorting, so the Flutter app does NOT need to sort.
- **Chat ID included** — the community's chat ID is now part of the detail response, so you don't need a separate API call to get it.
- **Membership flags** — `isMember` and `isCreator` tell the Flutter app whether to show "Leave" or not.

---

## Step 1: Understand the Updated API Response

### `GET /api/communities/:communityId`

This is the endpoint you call when the user taps on a community to see its details. Here is the full updated response:

```json
{
  "id": 1,
  "name": "My Community",
  "imageUrl": "https://s3.amazonaws.com/community-images/abc.jpg",
  "creatorId": 5,
  "chatId": 42,
  "isMember": true,
  "isCreator": false,
  "members": [
    {
      "id": 5,
      "username": "john_doe",
      "firstName": "John",
      "lastName": "Doe",
      "avatarUrl": "https://s3.amazonaws.com/minime/avatar1.png",
      "totalPoints": 500,
      "thisWeekPoints": 80,
      "profileUrl": "/api/users/5/profile",
      "isAdmin": true
    },
    {
      "id": 3,
      "username": "alice_smith",
      "firstName": "Alice",
      "lastName": "Smith",
      "avatarUrl": "https://s3.amazonaws.com/minime/avatar2.png",
      "totalPoints": 300,
      "thisWeekPoints": 40,
      "profileUrl": "/api/users/3/profile",
      "isAdmin": false
    },
    {
      "id": 7,
      "username": "bob_jones",
      "firstName": "Bob",
      "lastName": "Jones",
      "avatarUrl": null,
      "totalPoints": 150,
      "thisWeekPoints": 10,
      "profileUrl": "/api/users/7/profile",
      "isAdmin": false
    }
  ]
}
```

Here is what each **new** field means and why it exists:

| New Field | Type | Why It Exists | How You Use It |
|-----------|------|---------------|----------------|
| `creatorId` | `int` | Identifies which user created (and administers) this community | You can compare this to the logged-in user's ID to know if they are the admin |
| `chatId` | `int?` | The ID of the community's group chat. Previously you had to call `GET /communities/:id/chat-id` separately — now it's included here to save a network call | Use this to navigate the user directly to the chat screen when they tap "Chat" |
| `isMember` | `bool` | Tells you if the currently logged-in user is a member of this community | Use this to decide whether to show the "Leave" button. If `false`, the user is viewing a community they haven't joined |
| `isCreator` | `bool` | Tells you if the currently logged-in user is the creator/admin | Admins should NOT see a "Leave" button (they must delete the community instead). Use `isMember && !isCreator` to show the leave option |
| `members[].isAdmin` | `bool` | Tells you if a specific member in the list is the admin | Use this to show an "Admin" badge/label next to that member's name in the list |

**Important:** The `members` array is already sorted by the backend:
1. The admin is always the **first item** in the array
2. All other members are sorted **alphabetically by first name + last name**

You do NOT need to sort on the client side. Just render the array in order.

---

## Step 2: Update Your Dart Models

You need to add the new fields to whatever model/class you use to parse the community detail response. If you don't have a dedicated model yet, create one.

### CommunityDetail Model

Find your existing community detail model class and add the fields marked `// NEW`:

```dart
class CommunityDetail {
  final int id;
  final String name;
  final String? imageUrl;
  final int creatorId;
  final int? chatId;          // NEW — community chat ID
  final bool isMember;        // NEW — is current user a member?
  final bool isCreator;       // NEW — is current user the admin?
  final List<CommunityMember> members;

  CommunityDetail({
    required this.id,
    required this.name,
    this.imageUrl,
    required this.creatorId,
    this.chatId,
    required this.isMember,
    required this.isCreator,
    required this.members,
  });

  factory CommunityDetail.fromJson(Map<String, dynamic> json) {
    return CommunityDetail(
      id: json['id'],
      name: json['name'],
      imageUrl: json['imageUrl'],
      creatorId: json['creatorId'],
      chatId: json['chatId'],                // NEW — may be null if no chat exists yet
      isMember: json['isMember'] ?? false,    // NEW — defaults to false for safety
      isCreator: json['isCreator'] ?? false,   // NEW — defaults to false for safety
      members: (json['members'] as List)
          .map((m) => CommunityMember.fromJson(m))
          .toList(),
    );
  }
}
```

### CommunityMember Model

Find your existing community member model and add the `isAdmin` field:

```dart
class CommunityMember {
  final int id;
  final String username;
  final String? firstName;
  final String? lastName;
  final String? avatarUrl;
  final int totalPoints;
  final int thisWeekPoints;
  final String? profileUrl;
  final bool isAdmin;  // NEW — is this member the community admin?

  CommunityMember({
    required this.id,
    required this.username,
    this.firstName,
    this.lastName,
    this.avatarUrl,
    required this.totalPoints,
    required this.thisWeekPoints,
    this.profileUrl,
    required this.isAdmin,
  });

  factory CommunityMember.fromJson(Map<String, dynamic> json) {
    return CommunityMember(
      id: json['id'],
      username: json['username'],
      firstName: json['firstName'],
      lastName: json['lastName'],
      avatarUrl: json['avatarUrl'],
      totalPoints: json['totalPoints'] ?? 0,
      thisWeekPoints: json['thisWeekPoints'] ?? 0,
      profileUrl: json['profileUrl'],
      isAdmin: json['isAdmin'] ?? false,  // NEW — defaults to false
    );
  }
}
```

**Why `?? false` on booleans?** This is a safety measure. If for any reason the backend doesn't send these fields (e.g., older cached response), the app won't crash — it will just treat the value as `false`.

---

## Step 3: Build the Community Detail Screen UI

When the user taps on a community from the list, you call `GET /api/communities/:communityId` and display the detail screen. Here's how to build each section:

### 3.1 — Community Header

At the top of the screen, show the community name and image:

```dart
Column(
  children: [
    // Community image
    if (community.imageUrl != null)
      CircleAvatar(
        radius: 50,
        backgroundImage: NetworkImage(community.imageUrl!),
      )
    else
      const CircleAvatar(
        radius: 50,
        child: Icon(Icons.group, size: 40),
      ),
    const SizedBox(height: 12),

    // Community name
    Text(
      community.name,
      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
    ),
    const SizedBox(height: 4),

    // Member count
    Text(
      '${community.members.length} members',
      style: TextStyle(fontSize: 14, color: Colors.grey[600]),
    ),
  ],
)
```

### 3.2 — Action Buttons (Chat + Leave)

Below the header, show two action buttons. The chat button always shows (if chatId exists). The leave button only shows for non-admin members.

**Why this logic?**
- `community.chatId != null` — the community has a chat room. If it's null (which shouldn't normally happen), hide the button to avoid navigation errors.
- `community.isMember && !community.isCreator` — only show "Leave" to members who are NOT the admin. The admin cannot leave their own community (the backend will reject it with 403 anyway), so we hide the button entirely to avoid confusion.

```dart
Row(
  mainAxisAlignment: MainAxisAlignment.center,
  children: [
    // ---- Chat Access Button ----
    // WHY: The chatId is now included in the community detail response,
    // so we can navigate directly to the chat screen without an extra API call.
    // Previously, you had to call GET /communities/:id/chat-id first.
    if (community.chatId != null)
      ElevatedButton.icon(
        icon: const Icon(Icons.chat_bubble_outline),
        label: const Text('Community Chat'),
        onPressed: () {
          // Navigate to your existing chat screen using the chatId.
          // Replace ChatScreen with whatever your actual chat screen widget is called.
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => ChatScreen(chatId: community.chatId!),
            ),
          );
        },
      ),

    const SizedBox(width: 12),

    // ---- Leave Community Button ----
    // WHY: We only show this for members who are NOT the admin/creator.
    // The admin must delete the community instead of leaving it.
    // The backend enforces this too (returns 403 if admin tries to leave),
    // but we hide the button to prevent confusion.
    if (community.isMember && !community.isCreator)
      OutlinedButton.icon(
        icon: const Icon(Icons.exit_to_app, color: Colors.red),
        label: const Text('Leave', style: TextStyle(color: Colors.red)),
        style: OutlinedButton.styleFrom(side: const BorderSide(color: Colors.red)),
        onPressed: () => _showLeaveConfirmation(context, community.id),
      ),
  ],
)
```

### 3.3 — Member List (Admin First, Then Alphabetical)

The backend already returns members sorted correctly (admin first, rest alphabetical). You just render the list in order — do NOT re-sort it.

**Why show different UI for admin vs regular members?**
The requirement says "Admin at top" — the user should clearly see who runs the community. We show an "Admin" badge to make this obvious.

```dart
// Section title
const Padding(
  padding: EdgeInsets.symmetric(horizontal: 16, vertical: 12),
  child: Text(
    'Members',
    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
  ),
),

// Member list — render as-is, backend already sorted
ListView.builder(
  shrinkWrap: true,  // use this if inside a ScrollView
  physics: const NeverScrollableScrollPhysics(),  // disable inner scroll if inside a ScrollView
  itemCount: community.members.length,
  itemBuilder: (context, index) {
    final member = community.members[index];

    return ListTile(
      // Avatar
      leading: CircleAvatar(
        backgroundImage: member.avatarUrl != null
            ? NetworkImage(member.avatarUrl!)
            : null,
        child: member.avatarUrl == null
            ? Text(
                (member.firstName ?? member.username)[0].toUpperCase(),
                style: const TextStyle(fontWeight: FontWeight.bold),
              )
            : null,
      ),

      // Name
      title: Text(
        '${member.firstName ?? ''} ${member.lastName ?? ''}'.trim().isEmpty
            ? member.username
            : '${member.firstName ?? ''} ${member.lastName ?? ''}'.trim(),
      ),

      // Role label — shows "Admin" for the creator, "Member" for everyone else
      subtitle: Text(
        member.isAdmin ? 'Admin' : 'Member',
        style: TextStyle(
          color: member.isAdmin ? Colors.blue : Colors.grey,
          fontWeight: member.isAdmin ? FontWeight.w600 : FontWeight.normal,
        ),
      ),

      // Admin badge on the right side (optional visual indicator)
      trailing: member.isAdmin
          ? Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: Colors.blue.withOpacity(0.1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Text(
                'Admin',
                style: TextStyle(
                  color: Colors.blue,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            )
          : null,

      // Tap to view member's profile
      onTap: () {
        // Navigate to user profile screen
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => UserProfileScreen(userId: member.id),
          ),
        );
      },
    );
  },
)
```

---

## Step 4: Leave Community Flow

When the user taps "Leave", show a confirmation dialog first. After they confirm and the API succeeds, navigate them back so they can browse and join a different community.

**Why a confirmation dialog?** Leaving is a significant action — the user loses access to the community chat and member list. We want to prevent accidental taps.

**Why navigate back after leaving?** The community detail screen no longer makes sense once the user has left. They should be taken back to the community list/browse screen where they can find and join a new community.

```dart
/// Shows a confirmation dialog before leaving the community.
/// WHY: Prevent accidental leaves — once left, the user is removed from the
/// community chat too, so we want them to be sure.
void _showLeaveConfirmation(BuildContext context, int communityId) {
  showDialog(
    context: context,
    builder: (_) => AlertDialog(
      title: const Text('Leave Community?'),
      content: const Text(
        'You will be removed from this community and its chat. '
        'You can join a different community afterwards.\n\n'
        'Are you sure you want to leave?',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),  // Close dialog, do nothing
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () {
            Navigator.pop(context);  // Close dialog first
            _leaveCommunity(context, communityId);  // Then call API
          },
          child: const Text(
            'Leave',
            style: TextStyle(color: Colors.red, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );
}

/// Calls the leave community API and handles the response.
///
/// API: POST /api/communities/leave
/// Body: { "communityId": 123 }
///
/// Success (200): User removed from community + chat.
/// Error (403): "Creator cannot leave" — this shouldn't happen because we hide
///              the button for creators, but handle it just in case.
/// Error (404): "Not a member" — could happen if state is stale.
Future<void> _leaveCommunity(BuildContext context, int communityId) async {
  try {
    final response = await http.post(
      Uri.parse('$baseUrl/api/communities/leave'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
      body: jsonEncode({'communityId': communityId}),
    );

    if (response.statusCode == 200) {
      // SUCCESS — navigate back to community list screen
      // WHY: The user is no longer a member, so showing the detail screen
      // doesn't make sense. Take them back to browse communities.
      if (context.mounted) {
        Navigator.pop(context);  // Go back to community list
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('You left the community. You can now join a new one.'),
          ),
        );
      }
    } else {
      // FAILURE — show the error message from the backend
      final body = jsonDecode(response.body);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(body['error'] ?? 'Failed to leave community')),
        );
      }
    }
  } catch (e) {
    // NETWORK ERROR — no internet, timeout, etc.
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Network error. Please try again.')),
      );
    }
  }
}
```

---

## Step 5: Handle One-Community-Per-User on Join and Create

The backend now enforces that a user can only be in ONE community at a time. If the user tries to join or create a community while already being in one, the backend returns HTTP 409 with an error message.

**Why does this matter for Flutter?** If you don't handle the 409, the user will see a generic error. Instead, you should show a helpful message telling them to leave their current community first.

### 5.1 — Join Community (409 Handling)

Find your existing join community function and update it to handle the 409:

```dart
/// Calls the join community API.
///
/// API: POST /api/communities/join
/// Body: { "communityId": 123 }
///
/// Success (200): User joined the community and added to its chat.
/// Error (409): Two possible reasons:
///   1. "Already a member" — user is already in THIS community
///   2. "You are already a member of a community..." — user is in a DIFFERENT community
///      Response includes currentCommunityId and currentCommunityName so you can
///      show which community they need to leave first.
Future<void> joinCommunity(BuildContext context, int communityId) async {
  try {
    final response = await http.post(
      Uri.parse('$baseUrl/api/communities/join'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
      body: jsonEncode({'communityId': communityId}),
    );

    if (response.statusCode == 200) {
      // SUCCESS — navigate to the community detail screen
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Joined community successfully!')),
        );
        // Refresh or navigate to the community detail screen
      }
    } else if (response.statusCode == 409) {
      // CONFLICT — user is already in a community
      // The backend tells us which community they're in, so we can show a helpful message.
      final body = jsonDecode(response.body);
      final errorMsg = body['error'] as String;
      final currentName = body['currentCommunityName'];  // may be null if same-community case

      if (context.mounted) {
        // Show a dialog explaining the situation, not just a snackbar,
        // because this requires the user to take action (leave their current community).
        showDialog(
          context: context,
          builder: (_) => AlertDialog(
            title: const Text('Already in a Community'),
            content: Text(
              currentName != null
                  ? 'You are currently in "$currentName". '
                    'You need to leave that community before joining a new one.'
                  : errorMsg,
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      }
    } else {
      // OTHER ERROR
      final body = jsonDecode(response.body);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(body['error'] ?? 'Failed to join community')),
        );
      }
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Network error. Please try again.')),
      );
    }
  }
}
```

### 5.2 — Create Community (409 Handling)

The same 409 response happens when creating a community. Find your create community function and add the same 409 handling:

```dart
/// Calls the create community API.
///
/// API: POST /api/communities
/// Body: FormData with "name" field and optional "image" file
///
/// Success (200): Community created, user is automatically the admin + member.
/// Error (409): User is already in a community — must leave first.
Future<void> createCommunity(BuildContext context, String name, File? image) async {
  try {
    final request = http.MultipartRequest(
      'POST',
      Uri.parse('$baseUrl/api/communities'),
    );
    request.headers['Authorization'] = 'Bearer $token';
    request.fields['name'] = name;

    if (image != null) {
      request.files.add(await http.MultipartFile.fromPath('image', image.path));
    }

    final streamed = await request.send();
    final response = await http.Response.fromStream(streamed);

    if (response.statusCode == 200) {
      // SUCCESS
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Community created!')),
        );
        // Navigate to the new community detail screen
      }
    } else if (response.statusCode == 409) {
      // CONFLICT — same handling as join
      final body = jsonDecode(response.body);
      if (context.mounted) {
        showDialog(
          context: context,
          builder: (_) => AlertDialog(
            title: const Text('Already in a Community'),
            content: Text(body['error'] ?? 'You must leave your current community first.'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      }
    } else {
      final body = jsonDecode(response.body);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(body['error'] ?? 'Failed to create community')),
        );
      }
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Network error. Please try again.')),
      );
    }
  }
}
```

---

## Step 6: Remove the Separate Chat ID API Call (Optional Cleanup)

If your code currently calls `GET /api/communities/:id/chat-id` separately to get the chat ID, you can remove that call. The `chatId` is now part of the `GET /api/communities/:communityId` response.

**Before (2 API calls):**
```dart
// OLD — don't do this anymore
final detail = await fetchCommunityDetail(communityId);
final chatIdResponse = await fetchCommunityChatId(communityId);  // REMOVE THIS
```

**After (1 API call):**
```dart
// NEW — chatId is already in the detail response
final detail = await fetchCommunityDetail(communityId);
final chatId = detail.chatId;  // already available, no extra call needed
```

This is optional — the old endpoint still works. But removing it saves a network call and makes the app faster.

---

## Quick Reference — All API Endpoints

| Action | Method | Endpoint | Request Body | Success | Error Cases |
|--------|--------|----------|-------------|---------|-------------|
| View community | `GET` | `/api/communities/:communityId` | — | 200 with full detail | 404 not found |
| Join community | `POST` | `/api/communities/join` | `{ "communityId": 123 }` | 200 | 409 already in a community |
| Leave community | `POST` | `/api/communities/leave` | `{ "communityId": 123 }` | 200 | 403 creator can't leave, 404 not a member |
| Create community | `POST` | `/api/communities` | FormData: `name`, `image` (optional) | 200 | 409 already in a community |

---

## Checklist

Before marking this task as done, verify:

- [ ] `CommunityDetail` model has `chatId`, `isMember`, `isCreator` fields
- [ ] `CommunityMember` model has `isAdmin` field
- [ ] Community detail screen shows admin at the top of the member list with an "Admin" badge
- [ ] Other members appear alphabetically after the admin (no client-side sorting — just render the array)
- [ ] "Community Chat" button is visible and navigates to `ChatScreen(chatId: community.chatId!)`
- [ ] "Leave" button is visible only when `isMember == true && isCreator == false`
- [ ] Leave shows a confirmation dialog before calling the API
- [ ] After leaving, user is navigated back to the community list
- [ ] Join community handles 409 and shows a dialog explaining the user must leave first
- [ ] Create community handles 409 with the same dialog
- [ ] (Optional) Removed the separate `GET /communities/:id/chat-id` call
